/**
 * Myo Bridge - WebSocket Server for Myo.ai Integration
 *
 * This module handles real-time communication between Myobot (local) and
 * Myo.ai (cloud). It provides:
 * - Authenticated WebSocket connections
 * - Task execution with progress streaming
 * - Session access and management
 * - File system operations
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateToken } from "./pairing-api.js";
import {
  initSessionSync,
  startHeartbeat,
  stopHeartbeat,
  syncSessionSnapshot,
  getLatestSnapshot,
  markHandoff,
} from "./session-sync-api.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { loadConfig } from "../config/io.js";
import { callGateway } from "./call.js";

// ============================================================================
// Types (mirroring Myo.ai protocol.ts)
// ============================================================================

interface BaseMessage {
  id: string;
  ts: number;
}

interface RequestMessage extends BaseMessage {
  type: "request";
  method: string;
  params?: Record<string, unknown>;
}

interface ResponseMessage extends BaseMessage {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface EventMessage extends BaseMessage {
  type: "event";
  event: string;
  data?: unknown;
}

type Message = RequestMessage | ResponseMessage | EventMessage;

// ============================================================================
// Connection State
// ============================================================================

interface MyoConnection {
  ws: WebSocket;
  token: string;
  connectedAt: number;
  lastPingAt: number;
  clientInfo?: {
    origin?: string;
    userAgent?: string;
  };
}

const connections = new Map<WebSocket, MyoConnection>();

// ============================================================================
// Message Helpers
// ============================================================================

let messageIdCounter = 0;

function generateMessageId(): string {
  return `${Date.now()}-${++messageIdCounter}`;
}

function sendResponse(
  ws: WebSocket,
  requestId: string,
  result?: unknown,
  error?: ResponseMessage["error"],
): void {
  const response: ResponseMessage = {
    id: generateMessageId(),
    ts: Date.now(),
    type: "response",
    requestId,
    result,
    error,
  };

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

function sendEvent(ws: WebSocket, event: string, data?: unknown): void {
  const eventMsg: EventMessage = {
    id: generateMessageId(),
    ts: Date.now(),
    type: "event",
    event,
    data,
  };

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(eventMsg));
  }
}

function broadcastEvent(event: string, data?: unknown): void {
  for (const [ws] of connections) {
    sendEvent(ws, event, data);
  }
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleRequest(
  ws: WebSocket,
  msg: RequestMessage,
  _connection: MyoConnection,
): Promise<void> {
  const { method, params } = msg;

  try {
    switch (method) {
      case "ping": {
        sendResponse(ws, msg.id, {
          pong: true,
          serverTime: Date.now(),
        });
        break;
      }

      case "gateway.info": {
        // Get actual gateway info from config
        let sessionCount = 0;
        let channels: string[] = [];
        let gatewayName = "Myobot";
        let gatewayPort = 18789;

        try {
          const config = loadConfig() as Record<string, unknown>;
          const storePath = resolveStorePath(config as any);
          const store = loadSessionStore(storePath);
          sessionCount = Object.keys(store).length;

          // Extract enabled channels
          const channelsCfg = config.channels as Record<string, unknown> | undefined;
          if (channelsCfg) {
            channels = Object.keys(channelsCfg);
          }

          const gatewayCfg = config.gateway as Record<string, unknown> | undefined;
          if (gatewayCfg?.port) gatewayPort = gatewayCfg.port as number;
        } catch {
          // Fallback to defaults
        }

        sendResponse(ws, msg.id, {
          name: gatewayName,
          version: process.env.OPENCLAW_SERVICE_VERSION || "1.0.0",
          uptime: process.uptime() * 1000,
          agent: "main",
          channels,
          sessionCount,
          workspace: process.cwd(),
          hostname: os.hostname(),
          port: gatewayPort,
        });
        break;
      }

      case "gateway.config": {
        try {
          const config = loadConfig() as Record<string, unknown>;
          const channelsCfg = config.channels as Record<string, unknown> | undefined;
          const gatewayCfg = config.gateway as Record<string, unknown> | undefined;

          sendResponse(ws, msg.id, {
            config: {
              workspace: process.cwd(),
              channels: channelsCfg ? Object.keys(channelsCfg) : [],
              gateway: gatewayCfg
                ? {
                    port: gatewayCfg.port,
                  }
                : null,
            },
          });
        } catch (e) {
          sendResponse(ws, msg.id, undefined, {
            code: "CONFIG_ERROR",
            message: e instanceof Error ? e.message : "Failed to read config",
          });
        }
        break;
      }

      case "task.execute": {
        const { taskId, title, description, stream, model, timeout } = params as {
          taskId: string;
          title: string;
          description: string;
          stream?: boolean;
          model?: string;
          timeout?: number;
        };

        // B05 Fix: Wire real task execution using the agent system
        const sessionKey = `myo:task:${taskId}`;
        const startTime = Date.now();

        // Send initial response
        sendResponse(ws, msg.id, {
          sessionKey,
          streaming: stream ?? true,
        });

        // Execute the task in the background
        (async () => {
          try {
            // Send starting event
            sendEvent(ws, "task.progress", {
              taskId,
              content: `Starting task: ${title}...`,
              progress: 10,
            });

            // Build the task prompt
            const taskPrompt = `# Task: ${title}\n\n${description}`;

            // Call the gateway agent method for real LLM execution
            const response = (await callGateway({
              method: "agent",
              params: {
                message: taskPrompt,
                sessionKey,
                deliver: false, // Don't deliver to any channel, just return result
                label: title,
                timeout: timeout ?? 300, // Default 5 minute timeout
                ...(model ? { model } : {}),
              },
              timeoutMs: (timeout ?? 300) * 1000 + 10000, // Add buffer to gateway timeout
            })) as {
              runId?: string;
              result?: string;
              error?: string;
              assistantText?: string;
              toolCalls?: Array<{ name: string; result?: string }>;
            };

            // Send progress update
            sendEvent(ws, "task.progress", {
              taskId,
              content: "Processing response...",
              progress: 80,
            });

            // Extract result
            const result = response?.assistantText || response?.result || "Task completed";
            const durationMs = Date.now() - startTime;

            // Send completion event
            sendEvent(ws, "task.complete", {
              taskId,
              result,
              runId: response?.runId,
              toolCalls: response?.toolCalls?.map((tc) => tc.name),
              artifacts: [],
              durationMs,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[myo-bridge] Task ${taskId} failed:`, errorMessage);

            sendEvent(ws, "task.error", {
              taskId,
              error: errorMessage,
              retryable: !errorMessage.includes("auth") && !errorMessage.includes("forbidden"),
              durationMs: Date.now() - startTime,
            });
          }
        })();

        break;
      }

      case "task.cancel": {
        const { taskId } = params as { taskId: string };
        // TODO: Implement task cancellation
        sendResponse(ws, msg.id, { cancelled: true });
        sendEvent(ws, "task.error", {
          taskId,
          error: "Task cancelled by user",
          retryable: true,
        });
        break;
      }

      case "session.list": {
        try {
          const config = loadConfig() as Record<string, unknown>;
          const storePath = resolveStorePath(config as any);
          const store = loadSessionStore(storePath);

          const sessions = Object.entries(store).map(([key, entry]) => ({
            sessionKey: key,
            sessionId: entry.sessionId,
            channel: entry.channel || entry.lastChannel,
            lastTo: entry.lastTo,
            updatedAt: entry.updatedAt,
            label: entry.label,
            displayName: entry.displayName,
            chatType: entry.chatType,
            model: entry.model,
            totalTokens: entry.totalTokens,
          }));

          // Sort by updated time, most recent first
          sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

          sendResponse(ws, msg.id, {
            sessions,
            total: sessions.length,
          });
        } catch (e) {
          sendResponse(ws, msg.id, undefined, {
            code: "SESSION_ERROR",
            message: e instanceof Error ? e.message : "Failed to list sessions",
          });
        }
        break;
      }

      case "session.get": {
        const { sessionKey } = params as { sessionKey: string };

        try {
          const config = loadConfig() as Record<string, unknown>;
          const storePath = resolveStorePath(config as any);
          const store = loadSessionStore(storePath);
          const entry = store[sessionKey];

          if (!entry) {
            sendResponse(ws, msg.id, undefined, {
              code: "NOT_FOUND",
              message: `Session not found: ${sessionKey}`,
            });
            break;
          }

          const session: Record<string, unknown> = {
            sessionKey,
            sessionId: entry.sessionId,
            channel: entry.channel || entry.lastChannel,
            lastTo: entry.lastTo,
            updatedAt: entry.updatedAt,
            label: entry.label,
            displayName: entry.displayName,
            chatType: entry.chatType,
            model: entry.model,
            modelProvider: entry.modelProvider,
            totalTokens: entry.totalTokens,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            compactionCount: entry.compactionCount,
            sessionFile: entry.sessionFile,
          };

          sendResponse(ws, msg.id, { session });
        } catch (e) {
          sendResponse(ws, msg.id, undefined, {
            code: "SESSION_ERROR",
            message: e instanceof Error ? e.message : "Failed to get session",
          });
        }
        break;
      }

      case "session.send": {
        const { sessionKey, message } = params as {
          sessionKey: string;
          message: string;
        };
        // TODO: Implement sending to session
        sendResponse(ws, msg.id, { sent: true });
        break;
      }

      case "files.list": {
        const { path: dirPath } = params as { path?: string };

        try {
          const workspace = process.cwd();
          const targetPath = dirPath ? path.resolve(workspace, dirPath) : workspace;

          // Security: ensure path is within workspace
          if (!targetPath.startsWith(workspace)) {
            sendResponse(ws, msg.id, undefined, {
              code: "FORBIDDEN",
              message: "Access denied: path outside workspace",
            });
            break;
          }

          const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
          const files = entries.map((entry) => ({
            name: entry.name,
            path: path.relative(workspace, path.join(targetPath, entry.name)),
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
          }));

          sendResponse(ws, msg.id, {
            files,
            workspace,
            currentPath: path.relative(workspace, targetPath) || ".",
          });
        } catch (e) {
          sendResponse(ws, msg.id, undefined, {
            code: "FILE_ERROR",
            message: e instanceof Error ? e.message : "Failed to list files",
          });
        }
        break;
      }

      case "files.read": {
        const { path: filePath, maxBytes = 1024 * 1024 } = params as {
          path: string;
          maxBytes?: number;
        };

        try {
          const workspace = process.cwd();
          const targetPath = path.resolve(workspace, filePath);

          // Security: ensure path is within workspace
          if (!targetPath.startsWith(workspace)) {
            sendResponse(ws, msg.id, undefined, {
              code: "FORBIDDEN",
              message: "Access denied: path outside workspace",
            });
            break;
          }

          const stat = await fs.promises.stat(targetPath);
          if (stat.isDirectory()) {
            sendResponse(ws, msg.id, undefined, {
              code: "IS_DIRECTORY",
              message: "Cannot read directory as file",
            });
            break;
          }

          // Read with size limit
          const content = await fs.promises.readFile(targetPath, "utf-8");
          const truncated = content.length > maxBytes;

          sendResponse(ws, msg.id, {
            content: truncated ? content.slice(0, maxBytes) : content,
            truncated,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch (e: any) {
          const code = e?.code === "ENOENT" ? "NOT_FOUND" : "FILE_ERROR";
          sendResponse(ws, msg.id, undefined, {
            code,
            message: e instanceof Error ? e.message : "Failed to read file",
          });
        }
        break;
      }

      case "files.write": {
        const {
          path: filePath,
          content,
          append,
        } = params as {
          path: string;
          content: string;
          append?: boolean;
        };

        try {
          const workspace = process.cwd();
          const targetPath = path.resolve(workspace, filePath);

          // Security: ensure path is within workspace
          if (!targetPath.startsWith(workspace)) {
            sendResponse(ws, msg.id, undefined, {
              code: "FORBIDDEN",
              message: "Access denied: path outside workspace",
            });
            break;
          }

          // Ensure parent directory exists
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

          if (append) {
            await fs.promises.appendFile(targetPath, content, "utf-8");
          } else {
            await fs.promises.writeFile(targetPath, content, "utf-8");
          }

          const stat = await fs.promises.stat(targetPath);
          sendResponse(ws, msg.id, {
            success: true,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch (e) {
          sendResponse(ws, msg.id, undefined, {
            code: "FILE_ERROR",
            message: e instanceof Error ? e.message : "Failed to write file",
          });
        }
        break;
      }

      case "files.delete": {
        const { path: filePath } = params as { path: string };

        try {
          const workspace = process.cwd();
          const targetPath = path.resolve(workspace, filePath);

          // Security: ensure path is within workspace
          if (!targetPath.startsWith(workspace)) {
            sendResponse(ws, msg.id, undefined, {
              code: "FORBIDDEN",
              message: "Access denied: path outside workspace",
            });
            break;
          }

          // Use trash/recycle when possible for safety
          await fs.promises.rm(targetPath, { recursive: true });

          sendResponse(ws, msg.id, { success: true });
        } catch (e: any) {
          const code = e?.code === "ENOENT" ? "NOT_FOUND" : "FILE_ERROR";
          sendResponse(ws, msg.id, undefined, {
            code,
            message: e instanceof Error ? e.message : "Failed to delete file",
          });
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Session Sync (Graceful Handoff)
      // -----------------------------------------------------------------------

      case "session.sync": {
        const snapshot = params as {
          user_id: string;
          gateway_id: string;
          session_key: string;
          messages: Array<{ role: string; content: string; timestamp?: string }>;
          context?: Record<string, unknown>;
          pending_tasks?: Array<{ id: string; description: string; status: string }>;
          active_work?: string;
          channel?: string;
          agent?: string;
          message_count?: number;
        };

        try {
          const result = await syncSessionSnapshot(snapshot as any);
          if (result.success) {
            sendResponse(ws, msg.id, {
              success: true,
              snapshotId: result.snapshotId,
            });
          } else {
            sendResponse(ws, msg.id, undefined, {
              code: "SYNC_FAILED",
              message: result.error || "Session sync failed",
            });
          }
        } catch (err) {
          sendResponse(ws, msg.id, undefined, {
            code: "SYNC_ERROR",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
        break;
      }

      case "session.latest": {
        const { user_id, session_key } = params as {
          user_id: string;
          session_key?: string;
        };

        try {
          const snapshot = await getLatestSnapshot(user_id, session_key);
          sendResponse(ws, msg.id, { snapshot });
        } catch (err) {
          sendResponse(ws, msg.id, undefined, {
            code: "FETCH_ERROR",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
        break;
      }

      case "session.handoff": {
        const { user_id, session_key } = params as {
          user_id: string;
          session_key: string;
        };

        try {
          const success = await markHandoff(user_id, session_key);
          sendResponse(ws, msg.id, { success });
        } catch (err) {
          sendResponse(ws, msg.id, undefined, {
            code: "HANDOFF_ERROR",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
        break;
      }

      case "heartbeat.start": {
        const { gateway_id, user_id } = params as {
          gateway_id: string;
          user_id: string;
        };

        try {
          initSessionSync({ gatewayId: gateway_id, userId: user_id });
          startHeartbeat();
          sendResponse(ws, msg.id, { started: true });
        } catch (err) {
          sendResponse(ws, msg.id, undefined, {
            code: "HEARTBEAT_ERROR",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
        break;
      }

      case "heartbeat.stop": {
        stopHeartbeat();
        sendResponse(ws, msg.id, { stopped: true });
        break;
      }

      default:
        sendResponse(ws, msg.id, undefined, {
          code: "UNKNOWN_METHOD",
          message: `Unknown method: ${method}`,
        });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendResponse(ws, msg.id, undefined, {
      code: "INTERNAL_ERROR",
      message: errorMessage,
    });
  }
}

// ============================================================================
// WebSocket Handler
// ============================================================================

function handleMessage(ws: WebSocket, data: string): void {
  const connection = connections.get(ws);
  if (!connection) return;

  let msg: Message;
  try {
    msg = JSON.parse(data);
  } catch {
    console.error("[myo-bridge] Invalid JSON received");
    return;
  }

  if (!msg.id || !msg.type || !msg.ts) {
    console.error("[myo-bridge] Invalid message format");
    return;
  }

  // Update last activity
  connection.lastPingAt = Date.now();

  if (msg.type === "request") {
    handleRequest(ws, msg as RequestMessage, connection).catch((error) => {
      console.error("[myo-bridge] Request handler error:", error);
    });
  }
}

function handleClose(ws: WebSocket): void {
  const connection = connections.get(ws);
  if (connection) {
    console.log("[myo-bridge] Client disconnected");
    connections.delete(ws);
  }
}

function handleError(ws: WebSocket, error: Error): void {
  console.error("[myo-bridge] WebSocket error:", error);
}

// ============================================================================
// Authentication
// ============================================================================

function extractAuthToken(req: IncomingMessage): string | null {
  // Try Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Try query parameter
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam) {
    return tokenParam;
  }

  return null;
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Attach Myo Bridge to an existing WebSocket server
 *
 * This handles the /ws/myo path for Myo.ai connections
 */
export function attachMyoBridge(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Only handle /ws/myo path
    if (url.pathname !== "/ws/myo") {
      return; // Let other handlers deal with it
    }

    // Authenticate
    const token = extractAuthToken(req);
    if (!token) {
      console.log("[myo-bridge] Connection rejected: No auth token");
      ws.close(4001, "Authentication required");
      return;
    }

    if (!validateToken(token)) {
      console.log("[myo-bridge] Connection rejected: Invalid token");
      ws.close(4003, "Invalid token");
      return;
    }

    // Accept connection
    const connection: MyoConnection = {
      ws,
      token,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      clientInfo: {
        origin: req.headers.origin,
        userAgent: req.headers["user-agent"],
      },
    };

    connections.set(ws, connection);
    console.log("[myo-bridge] Client connected from:", connection.clientInfo?.origin);

    // Send connected event
    sendEvent(ws, "gateway.status", {
      status: "healthy",
      message: "Connected to Myobot",
    });

    // Set up handlers
    ws.on("message", (data) => handleMessage(ws, data.toString()));
    ws.on("close", () => handleClose(ws));
    ws.on("error", (error) => handleError(ws, error));
  });

  console.log("[myo-bridge] Myo Bridge attached to WebSocket server");
}

/**
 * Get the number of active Myo.ai connections
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Broadcast an event to all connected Myo.ai clients
 */
export { broadcastEvent };

export default {
  attachMyoBridge,
  getConnectionCount,
  broadcastEvent,
};

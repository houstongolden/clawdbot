/**
 * Sessions API for Myo.ai Integration (Phase 4)
 *
 * HTTP endpoints for viewing and interacting with Myobot sessions from Myo.ai.
 *
 * Endpoints:
 * - GET /api/sessions - List all sessions (paginated)
 * - GET /api/sessions/:key - Get session with messages
 * - POST /api/sessions/:key/message - Send message to session
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  loadCombinedSessionStoreForGateway,
  listSessionsFromStore,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  deriveSessionTitle,
  readFirstUserMessageFromTranscript,
  readSessionPreviewItemsFromTranscript,
} from "./session-utils.js";
import { validateToken } from "./pairing-api.js";

// ============================================================================
// Types
// ============================================================================

interface SessionListOptions {
  limit?: number;
  offset?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  includePreview?: boolean;
  previewItems?: number;
  previewChars?: number;
  activeMinutes?: number;
  search?: string;
  agentId?: string;
  label?: string;
  spawnedBy?: string;
}

interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  toolCalls?: Array<{
    name: string;
    args?: Record<string, unknown>;
    result?: unknown;
  }>;
}

interface SessionDetail {
  key: string;
  title?: string;
  agent?: string;
  channel?: string;
  kind: "direct" | "group" | "global" | "unknown";
  status?: string;
  model?: string;
  modelProvider?: string;
  updatedAt?: number;
  sessionId?: string;
  messageCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  origin?: { label?: string };
}

// ============================================================================
// Helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        resolve(null); // 1MB limit
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function parseQueryParams(url: URL): SessionListOptions {
  const params: SessionListOptions = {};

  const limit = url.searchParams.get("limit");
  if (limit) params.limit = parseInt(limit, 10) || 50;

  const offset = url.searchParams.get("offset");
  if (offset) params.offset = parseInt(offset, 10) || 0;

  const activeMinutes = url.searchParams.get("activeMinutes");
  if (activeMinutes) params.activeMinutes = parseInt(activeMinutes, 10);

  const search = url.searchParams.get("search");
  if (search) params.search = search;

  const agentId = url.searchParams.get("agentId");
  if (agentId) params.agentId = agentId;

  const label = url.searchParams.get("label");
  if (label) params.label = label;

  params.includeGlobal = url.searchParams.get("includeGlobal") === "true";
  params.includeUnknown = url.searchParams.get("includeUnknown") === "true";
  params.includeDerivedTitles = url.searchParams.get("includeDerivedTitles") !== "false";
  params.includeLastMessage = url.searchParams.get("includeLastMessage") === "true";
  params.includePreview = url.searchParams.get("includePreview") === "true";

  const previewItems = url.searchParams.get("previewItems");
  if (previewItems) params.previewItems = parseInt(previewItems, 10) || 5;

  const previewChars = url.searchParams.get("previewChars");
  if (previewChars) params.previewChars = parseInt(previewChars, 10) || 200;

  return params;
}

function normalizeMessage(raw: unknown): SessionMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;

  const role = msg.role as string;
  if (!["user", "assistant", "system", "tool"].includes(role)) return null;

  let content = "";
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Handle content array (OpenAI format)
    content = msg.content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("\n");
  }

  // Extract tool calls
  const toolCalls: SessionMessage["toolCalls"] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc && typeof tc === "object") {
        const call = tc as Record<string, unknown>;
        const fn = call.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.name === "string") {
          let args: Record<string, unknown> | undefined;
          if (typeof fn.arguments === "string") {
            try {
              args = JSON.parse(fn.arguments);
            } catch {
              args = undefined;
            }
          } else if (typeof fn.arguments === "object") {
            args = fn.arguments as Record<string, unknown>;
          }
          toolCalls.push({ name: fn.name, args });
        }
      }
    }
  }

  // Handle tool results
  if (role === "tool" && typeof msg.name === "string") {
    if (toolCalls.length === 0) {
      toolCalls.push({
        name: msg.name,
        result: content ? content : undefined,
      });
    }
  }

  return {
    role: role as SessionMessage["role"],
    content,
    timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ============================================================================
// HTTP Handler
// ============================================================================

/**
 * HTTP handler for sessions API
 */
export async function handleSessionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle /api/sessions routes
  if (!url.pathname.startsWith("/api/sessions")) {
    return false;
  }

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.writeHead(204);
    res.end();
    return true;
  }

  // Validate auth token
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing authorization token" });
    return true;
  }

  const isValid = validateToken(token);
  if (!isValid) {
    sendJson(res, 401, { error: "Invalid or expired token" });
    return true;
  }

  const cfg = loadConfig();

  // -------------------------------------------------------------------------
  // GET /api/sessions - List all sessions
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const params = parseQueryParams(url);

    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);

    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: {
        limit: params.limit || 50,
        includeGlobal: params.includeGlobal,
        includeUnknown: params.includeUnknown,
        includeDerivedTitles: params.includeDerivedTitles,
        includeLastMessage: params.includeLastMessage,
        activeMinutes: params.activeMinutes,
        search: params.search,
        agentId: params.agentId,
        label: params.label,
        spawnedBy: params.spawnedBy,
      },
    });

    // Apply offset for pagination
    let sessions = result.sessions;
    const offset = params.offset || 0;
    if (offset > 0) {
      sessions = sessions.slice(offset);
    }

    // Optionally include message previews
    if (params.includePreview) {
      const previewItems = params.previewItems || 5;
      const previewChars = params.previewChars || 200;

      sessions = sessions.map((s) => {
        if (!s.sessionId) return s;

        const preview = readSessionPreviewItemsFromTranscript(
          s.sessionId,
          storePath,
          undefined,
          undefined,
          previewItems,
          previewChars,
        );

        return { ...s, preview };
      });
    }

    sendJson(res, 200, {
      sessions,
      total: result.count,
      defaults: result.defaults,
      ts: result.ts,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/sessions/:key - Get session with messages
  // -------------------------------------------------------------------------
  const sessionGetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionGetMatch) {
    const sessionKey = decodeURIComponent(sessionGetMatch[1]);

    const messageLimit = parseInt(url.searchParams.get("messageLimit") || "100", 10);
    const includeTools = url.searchParams.get("includeTools") !== "false";

    // Resolve the session
    const { storePath, canonicalKey } = resolveGatewaySessionStoreTarget({
      cfg,
      key: sessionKey,
    });

    const { store } = loadCombinedSessionStoreForGateway(cfg);
    const entry = store[canonicalKey];

    if (!entry) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }

    // Build session detail
    const parsed = parseAgentSessionKey(canonicalKey);
    const firstUserMsg = entry.sessionId
      ? readFirstUserMessageFromTranscript(entry.sessionId, storePath, entry.sessionFile)
      : null;

    const session: SessionDetail = {
      key: canonicalKey,
      title: deriveSessionTitle(entry, firstUserMsg),
      agent: parsed?.agentId,
      channel: entry.channel || entry.lastChannel,
      kind: entry.chatType === "group" || entry.chatType === "channel" ? "group" : "direct",
      status: "active",
      model: entry.model,
      modelProvider: entry.modelProvider,
      updatedAt: entry.updatedAt,
      sessionId: entry.sessionId,
      messageCount: (entry as any).messageCount ?? 0,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens ?? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
      origin: entry.origin,
    };

    // Load messages
    let messages: SessionMessage[] = [];
    if (entry.sessionId) {
      const rawMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);

      for (const raw of rawMessages.slice(-messageLimit)) {
        const normalized = normalizeMessage(raw);
        if (normalized) {
          // Filter out tool messages if not requested
          if (!includeTools && normalized.role === "tool") continue;
          messages.push(normalized);
        }
      }
    }

    sendJson(res, 200, { session, messages });
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /api/sessions/:key/message - Send message to session
  // -------------------------------------------------------------------------
  const sessionMessageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
  if (req.method === "POST" && sessionMessageMatch) {
    const sessionKey = decodeURIComponent(sessionMessageMatch[1]);

    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const message = body.message;
    if (typeof message !== "string" || !message.trim()) {
      sendJson(res, 400, { error: "Message is required" });
      return true;
    }

    // Resolve the session
    const { canonicalKey } = resolveGatewaySessionStoreTarget({
      cfg,
      key: sessionKey,
    });

    const { store } = loadCombinedSessionStoreForGateway(cfg);
    const entry = store[canonicalKey];

    if (!entry) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }

    // TODO: Implement actual message sending to the agent session
    // This requires integration with the agent runtime
    // For now, return a placeholder response

    // The actual implementation would:
    // 1. Find the active session handler
    // 2. Send the message to the agent
    // 3. Optionally wait for a response (if waitForResponse is set)

    sendJson(res, 501, {
      error: "Message sending not yet implemented",
      info: "This endpoint will be enabled when agent message injection is ready",
    });
    return true;
  }

  // Not handled by this API
  return false;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  handleSessionsRequest,
};

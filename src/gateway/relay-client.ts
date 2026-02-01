/**
 * Myobot Relay Client
 *
 * Enables myo.ai cloud to communicate with local Myobot gateway via Supabase Realtime.
 * This bridges the gap between Vercel-hosted myo.ai and locally-running Myobot.
 *
 * Flow:
 * 1. Myobot connects to Supabase Realtime channel
 * 2. myo.ai sends requests via broadcast
 * 3. Myobot handles request and responds via broadcast
 *
 * Supported methods:
 * - ping: Health check
 * - files.list: List directory contents
 * - files.read: Read file content
 * - sessions.list: List chat sessions
 * - sessions.get: Get session with messages
 * - gateway.status: Get gateway status
 */

import { createClient, RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  loadCombinedSessionStoreForGateway,
  listSessionsFromStore,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  deriveSessionTitle,
  readFirstUserMessageFromTranscript,
} from "./session-utils.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

// ============================================================================
// Types
// ============================================================================

export interface RelayConfig {
  /** Enable relay connection to myo.ai cloud */
  enabled?: boolean;
  /** Automatically connect on gateway start */
  autoConnect?: boolean;
  /** Supabase project URL (defaults to env SUPABASE_URL or MYO_SUPABASE_URL) */
  supabaseUrl?: string;
  /** Supabase anon key (defaults to env SUPABASE_ANON_KEY or MYO_SUPABASE_ANON_KEY) */
  supabaseAnonKey?: string;
  /** User ID for channel subscription (required, from pairing) */
  userId?: string;
  /** Gateway ID for identification (auto-generated if not set) */
  gatewayId?: string;
  /** Reconnect on disconnect */
  reconnect?: boolean;
  /** Reconnect delay in ms */
  reconnectDelayMs?: number;
  /** Heartbeat interval in ms */
  heartbeatIntervalMs?: number;
}

interface RelayRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  ts: number;
  from?: string; // requesting client id
}

interface RelayResponse {
  id: string;
  requestId: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  ts: number;
  from: string; // gateway id
}

interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modified: string;
  created: string;
  extension?: string;
  isHidden: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const log = createSubsystemLogger("relay");

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DIRECTORY_ITEMS = 500;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

// Text file extensions (safe to read as UTF-8)
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".yaml",
  ".yml",
  ".xml",
  ".svg",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".csv",
  ".vue",
  ".svelte",
  ".astro",
  "",
]);

// ============================================================================
// Relay Client Class
// ============================================================================

export class MyobotRelayClient {
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private config: Required<
    Pick<RelayConfig, "supabaseUrl" | "supabaseAnonKey" | "userId" | "gatewayId">
  > &
    RelayConfig;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private machineName: string = "unknown";
  private capabilities = ["files", "sessions", "gateway"];
  private version = "1.0.0";

  constructor(config: RelayConfig) {
    // Resolve config with defaults and environment variables
    this.config = {
      enabled: config.enabled ?? true,
      autoConnect: config.autoConnect ?? true,
      supabaseUrl:
        config.supabaseUrl || process.env.MYO_SUPABASE_URL || process.env.SUPABASE_URL || "",
      supabaseAnonKey:
        config.supabaseAnonKey ||
        process.env.MYO_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        "",
      userId: config.userId || process.env.MYO_USER_ID || "",
      gatewayId:
        config.gatewayId || process.env.MYO_GATEWAY_ID || `gateway-${Date.now().toString(36)}`,
      reconnect: config.reconnect ?? true,
      reconnectDelayMs: config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    };
  }

  /**
   * Check if relay can be started (has required config)
   */
  canStart(): { ok: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { ok: false, reason: "relay disabled in config" };
    }
    if (!this.config.supabaseUrl) {
      return { ok: false, reason: "missing supabaseUrl" };
    }
    if (!this.config.supabaseAnonKey) {
      return { ok: false, reason: "missing supabaseAnonKey" };
    }
    if (!this.config.userId) {
      return { ok: false, reason: "missing userId" };
    }
    return { ok: true };
  }

  /**
   * Connect to Supabase Realtime and register with myo.ai
   */
  async connect(): Promise<{ connected: boolean; error?: string }> {
    const canStart = this.canStart();
    if (!canStart.ok) {
      return { connected: false, error: canStart.reason };
    }

    try {
      // Get machine name for display
      this.machineName = await getMachineDisplayName();

      // Initialize Supabase client
      this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      });

      // Register with myo.ai cloud API
      const registered = await this.registerWithCloud();
      if (!registered.ok) {
        log.warn(`failed to register with cloud: ${registered.error}`);
        // Continue anyway - registration may be optional
      }

      // Subscribe to the user's relay channel
      const channelName = `relay:${this.config.userId}`;
      this.channel = this.supabase.channel(channelName, {
        config: {
          broadcast: { self: false },
          presence: { key: this.config.gatewayId },
        },
      });

      // Handle incoming relay requests
      this.channel.on("broadcast", { event: "relay_request" }, async (payload) => {
        await this.handleRequest(payload.payload as RelayRequest);
      });

      // Track presence
      this.channel.on("presence", { event: "sync" }, () => {
        const state = this.channel?.presenceState();
        log.info(`presence sync: ${Object.keys(state || {}).length} clients`);
      });

      // Subscribe to channel
      await new Promise<void>((resolve, reject) => {
        this.channel!.subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            // Track presence with gateway info
            await this.channel!.track({
              gatewayId: this.config.gatewayId,
              machineName: this.machineName,
              capabilities: this.capabilities,
              version: this.version,
              online: true,
              connectedAt: new Date().toISOString(),
            });

            this.connected = true;
            log.info(`connected to relay channel: ${channelName}`);
            resolve();
          } else if (status === "CHANNEL_ERROR") {
            reject(new Error("channel error"));
          } else if (status === "TIMED_OUT") {
            reject(new Error("connection timed out"));
          } else if (status === "CLOSED") {
            this.handleDisconnect();
          }
        });
      });

      // Start heartbeat
      this.startHeartbeat();

      return { connected: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`failed to connect: ${errorMsg}`);

      // Schedule reconnect if enabled
      if (this.config.reconnect) {
        this.scheduleReconnect();
      }

      return { connected: false, error: errorMsg };
    }
  }

  /**
   * Register gateway with myo.ai cloud API
   */
  private async registerWithCloud(): Promise<{ ok: boolean; error?: string }> {
    try {
      // Determine cloud API URL from Supabase URL
      // Supabase URL: https://xxx.supabase.co -> Cloud URL: https://myo.ai
      const cloudApiUrl = process.env.MYO_CLOUD_API_URL || "https://myo.ai";

      const response = await fetch(`${cloudApiUrl}/api/gateway/relay/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gatewayId: this.config.gatewayId,
          userId: this.config.userId,
          machineName: this.machineName,
          version: this.version,
          capabilities: this.capabilities,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `HTTP ${response.status}: ${text}` };
      }

      const data = await response.json();
      log.info(`registered with cloud: ${JSON.stringify(data)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Handle incoming relay request
   */
  private async handleRequest(request: RelayRequest): Promise<void> {
    log.info(`relay request: ${request.method} (${request.id})`);

    try {
      let result: unknown;

      switch (request.method) {
        case "ping":
          result = await this.handlePing();
          break;

        case "gateway.status":
          result = await this.handleGatewayStatus();
          break;

        case "files.list":
          result = await this.handleFilesList(request.params);
          break;

        case "files.read":
          result = await this.handleFilesRead(request.params);
          break;

        case "sessions.list":
          result = await this.handleSessionsList(request.params);
          break;

        case "sessions.get":
          result = await this.handleSessionsGet(request.params);
          break;

        default:
          await this.sendResponse(request.id, undefined, {
            code: "METHOD_NOT_FOUND",
            message: `Unknown method: ${request.method}`,
          });
          return;
      }

      await this.sendResponse(request.id, result);
    } catch (err) {
      log.error(`request handler error: ${err instanceof Error ? err.message : String(err)}`);
      await this.sendResponse(request.id, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  /**
   * Send response back via broadcast
   */
  private async sendResponse(
    requestId: string,
    result?: unknown,
    error?: RelayResponse["error"],
  ): Promise<void> {
    if (!this.channel) return;

    const response: RelayResponse = {
      id: `resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestId,
      result,
      error,
      ts: Date.now(),
      from: this.config.gatewayId,
    };

    await this.channel.send({
      type: "broadcast",
      event: "relay_response",
      payload: response,
    });
  }

  // --------------------------------------------------------------------------
  // Request Handlers
  // --------------------------------------------------------------------------

  private async handlePing(): Promise<{ pong: true; serverTime: number; gatewayId: string }> {
    return {
      pong: true,
      serverTime: Date.now(),
      gatewayId: this.config.gatewayId,
    };
  }

  private async handleGatewayStatus(): Promise<{
    gatewayId: string;
    machineName: string;
    version: string;
    capabilities: string[];
    uptime: number;
    connected: boolean;
  }> {
    return {
      gatewayId: this.config.gatewayId,
      machineName: this.machineName,
      version: this.version,
      capabilities: this.capabilities,
      uptime: process.uptime(),
      connected: this.connected,
    };
  }

  private async handleFilesList(params?: Record<string, unknown>): Promise<{
    path: string;
    files: FileInfo[];
    parent: string | null;
    totalSize: number;
    itemCount: number;
  }> {
    const requestPath = (params?.path as string) || ".";
    const showHidden = params?.hidden === true;
    const workspace = this.getWorkspaceDir();

    // Resolve and validate path
    const safePath = this.resolveSafePath(requestPath, workspace);
    if (!safePath) {
      throw new Error("Invalid path or access denied");
    }

    // Check if path exists and is directory
    const stats = await fs.stat(safePath);
    if (!stats.isDirectory()) {
      throw new Error("Path is not a directory");
    }

    // Read directory
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const files: FileInfo[] = [];
    let totalSize = 0;

    for (const entry of entries.slice(0, MAX_DIRECTORY_ITEMS)) {
      if (!showHidden && entry.name.startsWith(".")) continue;

      try {
        const entryPath = path.join(safePath, entry.name);
        const entryStats = await fs.stat(entryPath);

        let type: "file" | "directory" | "symlink" = "file";
        if (entryStats.isDirectory()) type = "directory";
        else if (entryStats.isSymbolicLink()) type = "symlink";

        const ext = path.extname(entry.name).toLowerCase();

        files.push({
          name: entry.name,
          path: path.relative(workspace, entryPath) || ".",
          type,
          size: entryStats.size,
          modified: entryStats.mtime.toISOString(),
          created: entryStats.birthtime.toISOString(),
          extension: type === "file" ? ext : undefined,
          isHidden: entry.name.startsWith("."),
        });
        totalSize += entryStats.size;
      } catch {
        // Skip files we can't access
      }
    }

    // Sort: directories first, then alphabetically
    files.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });

    const relativePath = path.relative(workspace, safePath);
    const parentPath = relativePath ? path.dirname(relativePath) : null;

    return {
      path: relativePath || ".",
      files,
      parent: parentPath === "." ? null : parentPath,
      totalSize,
      itemCount: files.length,
    };
  }

  private async handleFilesRead(params?: Record<string, unknown>): Promise<{
    path: string;
    content: string;
    size: number;
    encoding: "utf8" | "base64";
    truncated: boolean;
  }> {
    const requestPath = params?.path as string;
    if (!requestPath) {
      throw new Error("Missing path parameter");
    }

    const workspace = this.getWorkspaceDir();
    const safePath = this.resolveSafePath(requestPath, workspace);
    if (!safePath) {
      throw new Error("Invalid path or access denied");
    }

    const stats = await fs.stat(safePath);
    if (!stats.isFile()) {
      throw new Error("Path is not a file");
    }

    if (stats.size > MAX_READ_SIZE) {
      throw new Error(`File too large (max ${MAX_READ_SIZE / 1024 / 1024}MB)`);
    }

    const ext = path.extname(safePath).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext);

    let content: string;
    let encoding: "utf8" | "base64";
    let truncated = false;

    if (isText) {
      const buffer = await fs.readFile(safePath);
      content = buffer.toString("utf8");
      encoding = "utf8";

      if (content.length > 500000) {
        content = content.slice(0, 500000);
        truncated = true;
      }
    } else {
      const buffer = await fs.readFile(safePath);
      content = buffer.toString("base64");
      encoding = "base64";
    }

    return {
      path: path.relative(workspace, safePath),
      content,
      size: stats.size,
      encoding,
      truncated,
    };
  }

  private async handleSessionsList(params?: Record<string, unknown>): Promise<{
    sessions: Array<{
      key: string;
      title?: string;
      channel?: string;
      agent?: string;
      updatedAt?: number;
      messageCount?: number;
    }>;
    total: number;
  }> {
    const cfg = loadConfig();
    const limit = (params?.limit as number) || 50;
    const includeGlobal = params?.includeGlobal === true;

    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);

    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: {
        limit,
        includeGlobal,
        includeUnknown: false,
        includeDerivedTitles: true,
      },
    });

    return {
      sessions: result.sessions.map((s) => {
        // Extract agent from session key if available
        const parsed = parseAgentSessionKey(s.key);
        return {
          key: s.key,
          title: s.derivedTitle || s.label,
          channel: s.channel || s.lastChannel,
          agent: parsed?.agentId,
          updatedAt: s.updatedAt ?? undefined,
          messageCount: (s as any).messageCount,
        };
      }),
      total: result.count,
    };
  }

  private async handleSessionsGet(params?: Record<string, unknown>): Promise<{
    session: {
      key: string;
      title?: string;
      channel?: string;
      agent?: string;
      updatedAt?: number;
    };
    messages: Array<{
      role: string;
      content: string;
      timestamp?: string;
    }>;
  }> {
    const sessionKey = params?.key as string;
    if (!sessionKey) {
      throw new Error("Missing session key");
    }

    const messageLimit = (params?.messageLimit as number) || 100;
    const cfg = loadConfig();

    const { storePath, canonicalKey } = resolveGatewaySessionStoreTarget({
      cfg,
      key: sessionKey,
    });

    const { store } = loadCombinedSessionStoreForGateway(cfg);
    const entry = store[canonicalKey];

    if (!entry) {
      throw new Error("Session not found");
    }

    const parsed = parseAgentSessionKey(canonicalKey);
    const firstUserMsg = entry.sessionId
      ? readFirstUserMessageFromTranscript(entry.sessionId, storePath, entry.sessionFile)
      : null;

    const session = {
      key: canonicalKey,
      title: deriveSessionTitle(entry, firstUserMsg),
      channel: entry.channel || entry.lastChannel,
      agent: parsed?.agentId,
      updatedAt: entry.updatedAt,
    };

    // Load messages
    const messages: Array<{ role: string; content: string; timestamp?: string }> = [];
    if (entry.sessionId) {
      const rawMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);

      for (const raw of rawMessages.slice(-messageLimit)) {
        if (raw && typeof raw === "object") {
          const msg = raw as Record<string, unknown>;
          const role = msg.role as string;
          if (!["user", "assistant", "system", "tool"].includes(role)) continue;

          let content = "";
          if (typeof msg.content === "string") {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
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

          messages.push({
            role,
            content,
            timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
          });
        }
      }
    }

    return { session, messages };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getWorkspaceDir(): string {
    const config = loadConfig();
    return config.agents?.defaults?.workspace || process.cwd();
  }

  private resolveSafePath(requestPath: string, workspace: string): string | null {
    try {
      const decodedPath = decodeURIComponent(requestPath);
      const normalizedPath = path.normalize(decodedPath);

      if (normalizedPath.includes("..") || normalizedPath.includes("\0")) {
        return null;
      }

      const fullPath = path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(workspace, normalizedPath);

      const resolvedWorkspace = path.resolve(workspace);
      const resolvedPath = path.resolve(fullPath);

      if (!resolvedPath.startsWith(resolvedWorkspace)) {
        return null;
      }

      return resolvedPath;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Connection Management
  // --------------------------------------------------------------------------

  private handleDisconnect(): void {
    this.connected = false;
    this.stopHeartbeat();

    log.warn("disconnected from relay channel");

    if (this.config.reconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    log.info(`scheduling reconnect in ${this.config.reconnectDelayMs}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, this.config.reconnectDelayMs);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(async () => {
      if (this.channel && this.connected) {
        try {
          await this.channel.track({
            gatewayId: this.config.gatewayId,
            machineName: this.machineName,
            capabilities: this.capabilities,
            version: this.version,
            online: true,
            lastHeartbeat: new Date().toISOString(),
          });
        } catch (err) {
          log.warn(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Disconnect from relay
   */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.channel) {
      try {
        await this.channel.untrack();
        await this.supabase?.removeChannel(this.channel);
      } catch (err) {
        log.warn(`disconnect error: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.channel = null;
    }

    this.connected = false;
    log.info("relay client disconnected");
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get gateway ID
   */
  getGatewayId(): string {
    return this.config.gatewayId;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let relayClientInstance: MyobotRelayClient | null = null;

/**
 * Initialize and start the relay client
 */
export async function startRelayClient(
  config?: Partial<RelayConfig>,
): Promise<{ started: boolean; error?: string; gatewayId?: string }> {
  if (relayClientInstance?.isConnected()) {
    return {
      started: true,
      gatewayId: relayClientInstance.getGatewayId(),
    };
  }

  // Load config from file if not provided
  const appConfig = loadConfig();
  const relayConfig: RelayConfig = {
    ...appConfig.gateway?.relay,
    ...config,
  };

  relayClientInstance = new MyobotRelayClient(relayConfig);

  const canStart = relayClientInstance.canStart();
  if (!canStart.ok) {
    log.info(`relay not started: ${canStart.reason}`);
    return { started: false, error: canStart.reason };
  }

  const result = await relayClientInstance.connect();

  if (result.connected) {
    return {
      started: true,
      gatewayId: relayClientInstance.getGatewayId(),
    };
  }

  return { started: false, error: result.error };
}

/**
 * Stop the relay client
 */
export async function stopRelayClient(): Promise<void> {
  if (relayClientInstance) {
    await relayClientInstance.disconnect();
    relayClientInstance = null;
  }
}

/**
 * Get relay client instance
 */
export function getRelayClient(): MyobotRelayClient | null {
  return relayClientInstance;
}

/**
 * Check if relay is enabled and can be started
 */
export function isRelayEnabled(): boolean {
  const config = loadConfig();
  return config.gateway?.relay?.enabled === true;
}

export default {
  MyobotRelayClient,
  startRelayClient,
  stopRelayClient,
  getRelayClient,
  isRelayEnabled,
};

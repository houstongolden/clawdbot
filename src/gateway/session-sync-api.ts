/**
 * Session Sync API for Graceful Handoff
 *
 * Enables session continuity between local Myobot and Myo.ai cloud.
 * When the local gateway disconnects (laptop closes), cloud can resume from snapshot.
 *
 * Endpoints:
 * - POST /api/session/sync - Push session snapshot to Supabase
 * - GET /api/session/latest - Get latest session snapshot
 * - POST /api/session/handoff - Mark session for cloud handoff
 * - POST /api/heartbeat - Gateway heartbeat ping
 *
 * Flow:
 * 1. Myobot syncs session state every N messages or M seconds
 * 2. Myobot sends heartbeat every 30s
 * 3. If heartbeat stops, cloud detects disconnect
 * 4. Cloud loads last snapshot and can resume conversation
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Types
// ============================================================================

interface SessionSnapshot {
  id?: string;
  user_id: string;
  gateway_id: string;
  session_key: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    timestamp?: string;
  }>;
  context?: Record<string, unknown>;
  pending_tasks?: Array<{
    id: string;
    description: string;
    status: string;
  }>;
  active_work?: string;
  channel?: string;
  agent?: string;
  message_count?: number;
  status?: "active" | "handed_off" | "resumed" | "expired";
}

interface HeartbeatPayload {
  gateway_id: string;
  session_count?: number;
  active_sessions?: string[];
}

interface SyncConfig {
  batchSize: number; // Sync after N messages
  intervalMs: number; // Or after M milliseconds
  maxMessagesPerSnapshot: number; // Limit snapshot size
}

// ============================================================================
// State
// ============================================================================

let supabase: SupabaseClient | null = null;
let gatewayId: string | null = null;
let userId: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

const syncConfig: SyncConfig = {
  batchSize: 5, // Sync every 5 messages
  intervalMs: 60000, // Or every 60 seconds
  maxMessagesPerSnapshot: 50, // Keep last 50 messages
};

// Track last sync per session
const lastSyncTime = new Map<string, number>();
const messageCounts = new Map<string, number>();

// ============================================================================
// Supabase Client
// ============================================================================

function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error("[session-sync] SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
    return null;
  }

  supabase = createClient(url, key);
  return supabase;
}

// ============================================================================
// Session Sync Functions
// ============================================================================

/**
 * Initialize session sync with gateway info
 */
export function initSessionSync(config: {
  gatewayId: string;
  userId: string;
  supabaseUrl?: string;
  supabaseKey?: string;
}): void {
  gatewayId = config.gatewayId;
  userId = config.userId;

  if (config.supabaseUrl && config.supabaseKey) {
    supabase = createClient(config.supabaseUrl, config.supabaseKey);
  }

  console.log(`[session-sync] Initialized for gateway ${gatewayId}`);
}

/**
 * Start heartbeat ping to Supabase
 */
export function startHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  const sendHeartbeat = async () => {
    if (!gatewayId) return;

    const db = getSupabase();
    if (!db) return;

    try {
      const activeSessions = Array.from(lastSyncTime.keys());

      const { error } = await db
        .from("gateway_connections")
        .update({
          last_heartbeat_at: new Date().toISOString(),
          status: "connected",
          session_count: activeSessions.length,
        })
        .eq("id", gatewayId);

      if (error) {
        console.error("[session-sync] Heartbeat failed:", error.message);
      }
    } catch (err) {
      console.error("[session-sync] Heartbeat error:", err);
    }
  };

  // Send initial heartbeat
  sendHeartbeat();

  // Then every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 30000);
  console.log("[session-sync] Heartbeat started (30s interval)");
}

/**
 * Stop heartbeat
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log("[session-sync] Heartbeat stopped");
  }
}

/**
 * Sync a session snapshot to Supabase
 */
export async function syncSessionSnapshot(snapshot: SessionSnapshot): Promise<{
  success: boolean;
  snapshotId?: string;
  error?: string;
}> {
  const db = getSupabase();
  if (!db) {
    return { success: false, error: "Database not configured" };
  }

  if (!snapshot.user_id || !snapshot.gateway_id || !snapshot.session_key) {
    return { success: false, error: "Missing required fields" };
  }

  try {
    // Trim messages to max limit
    const messages = snapshot.messages.slice(-syncConfig.maxMessagesPerSnapshot);

    // Upsert snapshot (update if exists, insert if not)
    const { data, error } = await db
      .from("session_snapshots")
      .upsert(
        {
          user_id: snapshot.user_id,
          gateway_id: snapshot.gateway_id,
          session_key: snapshot.session_key,
          messages,
          context: snapshot.context || {},
          pending_tasks: snapshot.pending_tasks || [],
          active_work: snapshot.active_work,
          channel: snapshot.channel,
          agent: snapshot.agent,
          message_count: snapshot.message_count || messages.length,
          status: "active",
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id,gateway_id,session_key",
          ignoreDuplicates: false,
        },
      )
      .select("id")
      .single();

    if (error) {
      console.error("[session-sync] Sync failed:", error.message);
      return { success: false, error: error.message };
    }

    // Update tracking
    lastSyncTime.set(snapshot.session_key, Date.now());
    messageCounts.set(snapshot.session_key, messages.length);

    console.log(
      `[session-sync] Synced session ${snapshot.session_key} (${messages.length} messages)`,
    );

    return { success: true, snapshotId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Get latest session snapshot for a user
 */
export async function getLatestSnapshot(
  targetUserId: string,
  sessionKey?: string,
): Promise<SessionSnapshot | null> {
  const db = getSupabase();
  if (!db) return null;

  try {
    let query = db
      .from("session_snapshots")
      .select("*")
      .eq("user_id", targetUserId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (sessionKey) {
      query = query.eq("session_key", sessionKey);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code !== "PGRST116") {
        // Not "no rows returned"
        console.error("[session-sync] Get snapshot failed:", error.message);
      }
      return null;
    }

    return data;
  } catch (err) {
    console.error("[session-sync] Get snapshot error:", err);
    return null;
  }
}

/**
 * Mark a session for handoff (preparing to close)
 */
export async function markHandoff(targetUserId: string, sessionKey: string): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;

  try {
    const { error } = await db
      .from("session_snapshots")
      .update({
        status: "handed_off",
        handed_off_at: new Date().toISOString(),
      })
      .eq("user_id", targetUserId)
      .eq("session_key", sessionKey)
      .eq("status", "active");

    if (error) {
      console.error("[session-sync] Handoff failed:", error.message);
      return false;
    }

    console.log(`[session-sync] Session ${sessionKey} marked for handoff`);
    return true;
  } catch (err) {
    console.error("[session-sync] Handoff error:", err);
    return false;
  }
}

/**
 * Check if session should sync based on config
 */
export function shouldSync(sessionKey: string, messageCount: number): boolean {
  const lastSync = lastSyncTime.get(sessionKey) || 0;
  const lastCount = messageCounts.get(sessionKey) || 0;

  const timeSinceSync = Date.now() - lastSync;
  const messagesSinceSync = messageCount - lastCount;

  return messagesSinceSync >= syncConfig.batchSize || timeSinceSync >= syncConfig.intervalMs;
}

/**
 * Update sync config
 */
export function updateSyncConfig(config: Partial<SyncConfig>): void {
  Object.assign(syncConfig, config);
  console.log("[session-sync] Config updated:", syncConfig);
}

// ============================================================================
// HTTP Handler
// ============================================================================

/**
 * HTTP handler for session sync API
 */
export async function handleSessionSyncRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle our routes
  if (!url.pathname.startsWith("/api/session") && !url.pathname.startsWith("/api/heartbeat")) {
    return false;
  }

  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /api/session/sync - Push session snapshot
  // -------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/session/sync") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let data: SessionSnapshot;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    // Use stored gateway/user if not provided
    if (!data.gateway_id && gatewayId) data.gateway_id = gatewayId;
    if (!data.user_id && userId) data.user_id = userId;

    if (!data.user_id || !data.gateway_id || !data.session_key) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing user_id, gateway_id, or session_key" }));
      return true;
    }

    const result = await syncSessionSnapshot(data);

    if (result.success) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          snapshotId: result.snapshotId,
        }),
      );
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/session/latest - Get latest snapshot
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/session/latest") {
    const targetUserId = url.searchParams.get("user_id") || userId;
    const sessionKey = url.searchParams.get("session_key") || undefined;

    if (!targetUserId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing user_id" }));
      return true;
    }

    const snapshot = await getLatestSnapshot(targetUserId, sessionKey);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ snapshot }));
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /api/session/handoff - Mark session for cloud handoff
  // -------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/session/handoff") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let data: { user_id?: string; session_key: string };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    const targetUserId = data.user_id || userId;
    if (!targetUserId || !data.session_key) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing user_id or session_key" }));
      return true;
    }

    const success = await markHandoff(targetUserId, data.session_key);

    res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success }));
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /api/heartbeat - Gateway heartbeat
  // -------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let data: HeartbeatPayload;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    const targetGatewayId = data.gateway_id || gatewayId;
    if (!targetGatewayId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing gateway_id" }));
      return true;
    }

    const db = getSupabase();
    if (!db) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Database not configured" }));
      return true;
    }

    const { error } = await db
      .from("gateway_connections")
      .update({
        last_heartbeat_at: new Date().toISOString(),
        status: "connected",
        session_count: data.session_count ?? 0,
      })
      .eq("id", targetGatewayId);

    if (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, timestamp: new Date().toISOString() }));
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/session/status - Get sync status
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/session/status") {
    const sessions = Array.from(lastSyncTime.entries()).map(([key, time]) => ({
      sessionKey: key,
      lastSyncAt: new Date(time).toISOString(),
      messageCount: messageCounts.get(key) || 0,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        gatewayId,
        userId,
        heartbeatActive: heartbeatInterval !== null,
        syncConfig,
        sessions,
      }),
    );
    return true;
  }

  return false;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  initSessionSync,
  startHeartbeat,
  stopHeartbeat,
  syncSessionSnapshot,
  getLatestSnapshot,
  markHandoff,
  shouldSync,
  updateSyncConfig,
  handleSessionSyncRequest,
};

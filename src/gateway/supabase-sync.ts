/**
 * Supabase Sync Service for Myobot
 *
 * Syncs tasks, sessions, and other data between local Myobot and Supabase.
 * Enables the unified Myo platform where web, desktop, and local all stay in sync.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Types
// ============================================================================

export interface Task {
  id: string;
  user_id: string;
  project_id?: string;
  title: string;
  description?: string;
  status: "pending" | "queued" | "running" | "completed" | "failed" | "cancelled";
  priority?: string;
  due_date?: string;
  assigned_gateway_id?: string;
  execution_session_key?: string;
  execution_started_at?: string;
  execution_completed_at?: string;
  execution_duration_ms?: number;
  execution_result?: string;
  execution_error?: string;
  artifacts?: Array<{ name: string; path: string; type: string; size?: number }>;
  created_at: string;
  updated_at: string;
}

export interface GatewaySession {
  id: string;
  gateway_id: string;
  user_id: string;
  session_key: string;
  title?: string;
  channel?: string;
  agent?: string;
  message_count: number;
  last_message_at?: string;
  summary?: string;
  linked_task_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  title?: string;
  content?: string;
  content_type: "markdown" | "plain" | "html";
  folder: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  linked_task_id?: string;
  linked_project_id?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Supabase Client
// ============================================================================

let supabaseClient: SupabaseClient | null = null;

interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey?: string; // For server-side operations
}

/**
 * Initialize Supabase client
 */
export function initSupabase(config: SupabaseConfig): SupabaseClient {
  supabaseClient = createClient(config.url, config.serviceKey || config.anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: false, // Server-side, no session persistence
    },
  });

  console.log("[supabase-sync] Supabase client initialized");
  return supabaseClient;
}

/**
 * Get Supabase client (must be initialized first)
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    throw new Error("Supabase not initialized. Call initSupabase() first.");
  }
  return supabaseClient;
}

// ============================================================================
// Tasks API
// ============================================================================

/**
 * Get tasks assigned to this gateway
 */
export async function getAssignedTasks(gatewayId: string): Promise<Task[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("assigned_gateway_id", gatewayId)
    .in("status", ["pending", "queued"])
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[supabase-sync] Error fetching assigned tasks:", error);
    return [];
  }

  return data || [];
}

/**
 * Get all pending tasks for a user (not yet assigned)
 */
export async function getPendingTasks(userId: string): Promise<Task[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .is("assigned_gateway_id", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[supabase-sync] Error fetching pending tasks:", error);
    return [];
  }

  return data || [];
}

/**
 * Claim a task for execution
 */
export async function claimTask(taskId: string, gatewayId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from("tasks")
    .update({
      assigned_gateway_id: gatewayId,
      status: "queued",
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId)
    .eq("status", "pending"); // Only claim if still pending

  if (error) {
    console.error("[supabase-sync] Error claiming task:", error);
    return false;
  }

  return true;
}

/**
 * Mark task as running
 */
export async function startTask(taskId: string, sessionKey: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from("tasks")
    .update({
      status: "running",
      execution_session_key: sessionKey,
      execution_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);

  if (error) {
    console.error("[supabase-sync] Error starting task:", error);
    return false;
  }

  return true;
}

/**
 * Mark task as completed
 */
export async function completeTask(
  taskId: string,
  result: string,
  artifacts?: Task["artifacts"],
): Promise<boolean> {
  const supabase = getSupabase();

  // First get the task to calculate duration
  const { data: task } = await supabase
    .from("tasks")
    .select("execution_started_at")
    .eq("id", taskId)
    .single();

  const startedAt = task?.execution_started_at ? new Date(task.execution_started_at) : new Date();
  const durationMs = Date.now() - startedAt.getTime();

  const { error } = await supabase
    .from("tasks")
    .update({
      status: "completed",
      execution_result: result,
      execution_completed_at: new Date().toISOString(),
      execution_duration_ms: durationMs,
      artifacts: artifacts || [],
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);

  if (error) {
    console.error("[supabase-sync] Error completing task:", error);
    return false;
  }

  return true;
}

/**
 * Mark task as failed
 */
export async function failTask(taskId: string, error: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error: dbError } = await supabase
    .from("tasks")
    .update({
      status: "failed",
      execution_error: error,
      execution_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);

  if (dbError) {
    console.error("[supabase-sync] Error failing task:", dbError);
    return false;
  }

  return true;
}

// ============================================================================
// Sessions API
// ============================================================================

/**
 * Sync a local session to Supabase
 */
export async function syncSession(
  gatewayId: string,
  userId: string,
  session: {
    key: string;
    title?: string;
    channel?: string;
    agent?: string;
    messageCount: number;
    lastMessageAt?: Date;
  },
): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase.from("gateway_sessions").upsert(
    {
      gateway_id: gatewayId,
      user_id: userId,
      session_key: session.key,
      title: session.title,
      channel: session.channel,
      agent: session.agent,
      message_count: session.messageCount,
      last_message_at: session.lastMessageAt?.toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "gateway_id,session_key",
    },
  );

  if (error) {
    console.error("[supabase-sync] Error syncing session:", error);
    return false;
  }

  return true;
}

/**
 * Get synced sessions for a gateway
 */
export async function getSyncedSessions(gatewayId: string): Promise<GatewaySession[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("gateway_sessions")
    .select("*")
    .eq("gateway_id", gatewayId)
    .order("last_message_at", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[supabase-sync] Error fetching sessions:", error);
    return [];
  }

  return data || [];
}

// ============================================================================
// Notes API
// ============================================================================

/**
 * Get notes for a user
 */
export async function getNotes(
  userId: string,
  options?: { folder?: string; pinned?: boolean; limit?: number },
): Promise<Note[]> {
  const supabase = getSupabase();

  let query = supabase.from("notes").select("*").eq("user_id", userId).eq("archived", false);

  if (options?.folder) {
    query = query.eq("folder", options.folder);
  }
  if (options?.pinned !== undefined) {
    query = query.eq("pinned", options.pinned);
  }

  query = query.order("pinned", { ascending: false }).order("updated_at", { ascending: false });

  if (options?.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[supabase-sync] Error fetching notes:", error);
    return [];
  }

  return data || [];
}

/**
 * Create or update a note
 */
export async function upsertNote(
  userId: string,
  note: Partial<Note> & { id?: string },
): Promise<Note | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("notes")
    .upsert({
      ...note,
      user_id: userId,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("[supabase-sync] Error upserting note:", error);
    return null;
  }

  return data;
}

/**
 * Delete a note
 */
export async function deleteNote(noteId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase.from("notes").delete().eq("id", noteId);

  if (error) {
    console.error("[supabase-sync] Error deleting note:", error);
    return false;
  }

  return true;
}

// ============================================================================
// Real-time Subscriptions
// ============================================================================

/**
 * Subscribe to task changes for a gateway
 */
export function subscribeToTasks(
  gatewayId: string,
  callback: (task: Task, eventType: "INSERT" | "UPDATE" | "DELETE") => void,
): () => void {
  const supabase = getSupabase();

  const subscription = supabase
    .channel(`tasks:${gatewayId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "tasks",
        filter: `assigned_gateway_id=eq.${gatewayId}`,
      },
      (payload) => {
        const eventType = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        const task = (payload.new || payload.old) as Task;
        callback(task, eventType);
      },
    )
    .subscribe();

  return () => {
    subscription.unsubscribe();
  };
}

export default {
  initSupabase,
  getSupabase,
  getAssignedTasks,
  getPendingTasks,
  claimTask,
  startTask,
  completeTask,
  failTask,
  syncSession,
  getSyncedSessions,
  getNotes,
  upsertNote,
  deleteNote,
  subscribeToTasks,
};

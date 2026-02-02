import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceClient } from "./supabase.js";

export type McTaskStatus = "inbox" | "assigned" | "in_progress" | "review" | "done" | "blocked";

export type McTaskPriority = "low" | "normal" | "high" | "urgent";

export interface McAgent {
  id: string;
  name: string;
  session_key: string;
}

export interface McTask {
  id: string;
  title: string;
  description: string | null;
  status: McTaskStatus;
  priority: McTaskPriority | null;
  tags: string[] | null;
  due_date: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface McActivityInsert {
  type: string;
  agent_id?: string | null;
  task_id?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

function getDb(): SupabaseClient | null {
  return getSupabaseServiceClient();
}

export async function fetchMcAgentByName(name: string): Promise<McAgent | null> {
  const db = getDb();
  if (!db) return null;

  const { data, error } = await db
    .from("mc_agents")
    .select("id,name,session_key")
    .eq("name", name)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[mission-control] fetchMcAgentByName error", error);
    return null;
  }

  return (data as McAgent) ?? null;
}

export async function fetchAssignedMcTasks(opts: {
  agentName: string;
  includeDone?: boolean;
  limit?: number;
}): Promise<{ agent: McAgent | null; tasks: McTask[] } | null> {
  const db = getDb();
  if (!db) return null;

  const agent = await fetchMcAgentByName(opts.agentName);
  if (!agent) return { agent: null, tasks: [] };

  let q = db
    .from("mc_tasks")
    .select("id,title,description,status,priority,tags,due_date,updated_at,created_at")
    .contains("assignee_ids", [agent.id])
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(opts.limit ?? 20, 50)));

  if (!opts.includeDone) {
    q = q.neq("status", "done");
  }

  const { data, error } = await q;

  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[mission-control] fetchAssignedMcTasks error", error);
    return null;
  }

  return { agent, tasks: (data as McTask[]) ?? [] };
}

export async function updateMcTaskStatus(opts: {
  taskId: string;
  status: McTaskStatus;
}): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const { error } = await db.from("mc_tasks").update({ status: opts.status }).eq("id", opts.taskId);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[mission-control] updateMcTaskStatus error", error);
    return false;
  }
  return true;
}

export async function insertMcActivity(activity: McActivityInsert): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const { error } = await db.from("mc_activities").insert({
    type: activity.type,
    agent_id: activity.agent_id ?? null,
    task_id: activity.task_id ?? null,
    message: activity.message,
    metadata: activity.metadata ?? {},
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[mission-control] insertMcActivity error", error);
    return false;
  }
  return true;
}

export function renderTasksAsHeartbeatMarkdown(opts: {
  agentName: string;
  tasks: McTask[];
}): string {
  const lines: string[] = [];
  lines.push(`# Mission Control Tasks (${opts.agentName})`);

  if (!opts.tasks.length) {
    lines.push("(none)");
    return lines.join("\n");
  }

  for (const t of opts.tasks) {
    const metaBits: string[] = [];
    if (t.status) metaBits.push(t.status);
    if (t.priority) metaBits.push(t.priority);
    if (t.due_date) metaBits.push(`due ${t.due_date}`);

    const meta = metaBits.length ? ` (${metaBits.join(", ")})` : "";
    lines.push(`- ${t.title}${meta} [${t.id}]`);
    if (t.description) {
      const desc = t.description.trim();
      if (desc) lines.push(`  - ${desc}`);
    }
    if (t.tags?.length) {
      lines.push(`  - tags: ${t.tags.join(", ")}`);
    }
  }

  return lines.join("\n");
}

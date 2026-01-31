/**
 * Task Sync for Myo.ai Integration
 *
 * Polls Supabase for tasks assigned to this gateway and executes them.
 * Updates task status as execution progresses.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Gateway ID (set during pairing)
let gatewayId: string | null = null;
let supabase: SupabaseClient | null = null;
let pollInterval: NodeJS.Timeout | null = null;

interface Task {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  status: string;
  success_criteria?: string;
  assigned_gateway_id: string;
}

/**
 * Initialize task sync with Supabase credentials
 */
export function initTaskSync(config: {
  supabaseUrl: string;
  supabaseKey: string;
  gatewayId: string;
}): void {
  supabase = createClient(config.supabaseUrl, config.supabaseKey);
  gatewayId = config.gatewayId;

  console.log(`[task-sync] Initialized for gateway: ${gatewayId}`);
}

/**
 * Start polling for assigned tasks
 */
export function startPolling(intervalMs = 30000): void {
  if (!supabase || !gatewayId) {
    console.error("[task-sync] Not initialized. Call initTaskSync first.");
    return;
  }

  if (pollInterval) {
    clearInterval(pollInterval);
  }

  // Initial poll
  pollForTasks();

  // Set up interval
  pollInterval = setInterval(pollForTasks, intervalMs);
  console.log(`[task-sync] Polling every ${intervalMs / 1000}s`);
}

/**
 * Stop polling
 */
export function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[task-sync] Polling stopped");
  }
}

/**
 * Poll for tasks assigned to this gateway
 */
async function pollForTasks(): Promise<void> {
  if (!supabase || !gatewayId) return;

  try {
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("assigned_gateway_id", gatewayId)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(5);

    if (error) {
      console.error("[task-sync] Poll error:", error.message);
      return;
    }

    if (tasks && tasks.length > 0) {
      console.log(`[task-sync] Found ${tasks.length} queued task(s)`);

      // Process tasks sequentially for now
      for (const task of tasks) {
        await executeTask(task);
      }
    }
  } catch (err) {
    console.error("[task-sync] Poll error:", err);
  }
}

/**
 * Execute a single task
 */
async function executeTask(task: Task): Promise<void> {
  if (!supabase) return;

  console.log(`[task-sync] Executing task: ${task.title}`);

  // Update status to in_progress
  await supabase
    .from("tasks")
    .update({
      status: "in_progress",
      execution_started_at: new Date().toISOString(),
    })
    .eq("id", task.id);

  const startTime = Date.now();

  try {
    // Build the task prompt
    const prompt = buildTaskPrompt(task);

    // Execute via sessions_spawn (this would be called via the gateway's internal API)
    // For now, we'll emit an event that the main gateway loop can pick up
    const result = await executeViaAgent(task.id, prompt);

    const durationMs = Date.now() - startTime;

    // Update task with success
    await supabase
      .from("tasks")
      .update({
        status: "review", // Needs human review
        execution_completed_at: new Date().toISOString(),
        execution_duration_ms: durationMs,
        execution_result: result.summary,
        agent_summary: result.summary,
      })
      .eq("id", task.id);

    console.log(`[task-sync] Task completed: ${task.title} (${durationMs}ms)`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";

    // Update task with failure
    await supabase
      .from("tasks")
      .update({
        status: "failed",
        execution_completed_at: new Date().toISOString(),
        execution_duration_ms: durationMs,
        execution_error: errorMessage,
      })
      .eq("id", task.id);

    console.error(`[task-sync] Task failed: ${task.title}`, errorMessage);
  }
}

/**
 * Build a prompt for the agent from the task
 */
function buildTaskPrompt(task: Task): string {
  let prompt = `# Task: ${task.title}\n\n`;

  if (task.description) {
    prompt += `## Description\n${task.description}\n\n`;
  }

  if (task.success_criteria) {
    prompt += `## Success Criteria\n${task.success_criteria}\n\n`;
  }

  prompt += `## Instructions
Execute this task to completion. When done, provide a clear summary of:
- What was accomplished
- Any files created or modified
- Any issues encountered
- Next steps (if any)
`;

  return prompt;
}

/**
 * Execute task via the agent
 * This is a placeholder - in production, this would call sessions_spawn
 */
async function executeViaAgent(taskId: string, prompt: string): Promise<{ summary: string }> {
  // TODO: Integrate with sessions_spawn tool
  // For now, we'll use the gateway's internal execution mechanism

  // This would be replaced with actual agent execution:
  // const result = await sessions_spawn({
  //   task: prompt,
  //   label: `task-${taskId}`,
  //   cleanup: 'keep',
  // });

  return new Promise((resolve) => {
    // Simulate execution for testing
    setTimeout(() => {
      resolve({
        summary: `Task executed successfully. [Placeholder - actual agent execution pending]`,
      });
    }, 1000);
  });
}

/**
 * Get current sync status
 */
export function getSyncStatus(): {
  initialized: boolean;
  polling: boolean;
  gatewayId: string | null;
} {
  return {
    initialized: !!supabase && !!gatewayId,
    polling: !!pollInterval,
    gatewayId,
  };
}

export default {
  initTaskSync,
  startPolling,
  stopPolling,
  getSyncStatus,
};

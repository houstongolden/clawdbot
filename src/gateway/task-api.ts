/**
 * Task API for Myo.ai Integration
 *
 * Handles task execution requests from Myo.ai cloud.
 *
 * Endpoints:
 * - POST /api/tasks/:id/claim - Claim and start executing a task
 * - GET /api/tasks/status - Get current task execution status
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { callGateway } from "./call.js";

// Supabase client (initialized on first use)
let supabase: SupabaseClient | null = null;

interface ActiveTask {
  id: string;
  title: string;
  status: "claimed" | "executing" | "completed" | "failed";
  startedAt: number;
  progress?: string;
}

// Active tasks being executed
const activeTasks = new Map<string, ActiveTask>();

/**
 * Initialize Supabase client
 */
function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error("[task-api] SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
    return null;
  }

  supabase = createClient(url, key);
  return supabase;
}

/**
 * Validate auth token from request
 */
function validateAuth(req: IncomingMessage): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;

  // TODO: Validate against approved tokens from pairing
  // For now, accept any bearer token
  return true;
}

/**
 * HTTP handler for task API
 */
export async function handleTaskRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle /api/tasks routes
  if (!url.pathname.startsWith("/api/tasks")) {
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

  // POST /api/tasks/:id/claim - Claim and execute a task
  const claimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);
  if (req.method === "POST" && claimMatch) {
    const taskId = claimMatch[1];

    if (!validateAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    const db = getSupabase();
    if (!db) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Database not configured" }));
      return true;
    }

    // Fetch task
    const { data: task, error } = await db.from("tasks").select("*").eq("id", taskId).single();

    if (error || !task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return true;
    }

    // Check if task is in claimable state
    if (!["queued", "pending"].includes(task.status)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Cannot claim task with status: ${task.status}`,
        }),
      );
      return true;
    }

    // Mark as claimed
    activeTasks.set(taskId, {
      id: taskId,
      title: task.title,
      status: "claimed",
      startedAt: Date.now(),
    });

    // Update status in Supabase
    await db
      .from("tasks")
      .update({
        status: "in_progress",
        execution_started_at: new Date().toISOString(),
      })
      .eq("id", taskId);

    // Start execution in background
    executeTask(task).catch(console.error);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        taskId,
        status: "claimed",
      }),
    );
    return true;
  }

  // GET /api/tasks/status - Get execution status
  if (req.method === "GET" && url.pathname === "/api/tasks/status") {
    const tasks = Array.from(activeTasks.values());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks }));
    return true;
  }

  // GET /api/tasks/:id/status - Get specific task status
  const statusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === "GET" && statusMatch) {
    const taskId = statusMatch[1];
    const task = activeTasks.get(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not active" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ task }));
    return true;
  }

  // GET /api/tasks/:id/stream - Stream task progress (SSE)
  const streamMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const taskId = streamMatch[1];
    const task = activeTasks.get(taskId);

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial status
    const sendEvent = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (!task) {
      sendEvent({ type: "error", error: "Task not found" });
      res.end();
      return true;
    }

    sendEvent({ type: "status", task });

    // Poll for updates every second
    const intervalId = setInterval(() => {
      const currentTask = activeTasks.get(taskId);
      if (!currentTask) {
        sendEvent({ type: "completed", message: "Task no longer active" });
        clearInterval(intervalId);
        res.end();
        return;
      }

      sendEvent({ type: "progress", task: currentTask });

      // End stream if task is done
      if (currentTask.status === "completed" || currentTask.status === "failed") {
        sendEvent({ type: "done", task: currentTask });
        clearInterval(intervalId);
        res.end();
      }
    }, 1000);

    // Clean up on client disconnect
    req.on("close", () => {
      clearInterval(intervalId);
    });

    return true;
  }

  return false;
}

/**
 * Build a comprehensive prompt for task execution
 */
function buildTaskPrompt(task: {
  id: string;
  title: string;
  description?: string;
  success_criteria?: string;
}): string {
  let prompt = `# Task Execution Request

## Task: ${task.title}
`;

  if (task.description) {
    prompt += `
## Description
${task.description}
`;
  }

  if (task.success_criteria) {
    prompt += `
## Success Criteria
${task.success_criteria}
`;
  }

  prompt += `
## Instructions
Execute this task to completion. When done, provide:
1. A clear summary of what was accomplished
2. Any files created or modified
3. Any issues encountered
4. Next steps if any remain

Be thorough but efficient. This task was assigned from Myo.ai cloud interface.
`;

  return prompt;
}

/**
 * Execute a task via the agent
 */
async function executeTask(task: {
  id: string;
  title: string;
  description?: string;
  success_criteria?: string;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;

  const startTime = Date.now();
  const activeTask = activeTasks.get(task.id);
  if (activeTask) {
    activeTask.status = "executing";
    activeTask.progress = "Starting agent execution...";
  }

  // Create a unique session key for this task
  const sessionKey = `task:${task.id}`;

  try {
    console.log(`[task-api] Executing task: ${task.title}`);

    // Build task prompt
    const prompt = buildTaskPrompt(task);

    // Update progress
    if (activeTask) {
      activeTask.progress = "Agent working on task...";
    }

    // Call the gateway agent to execute the task
    // This runs the full agent loop with tools access
    const response = (await callGateway({
      method: "agent",
      params: {
        message: prompt,
        sessionKey,
        deliver: false, // Don't deliver to any channel
        timeout: 300, // 5 minute timeout for task execution
      },
      timeoutMs: 310_000, // Slightly longer than agent timeout
    })) as {
      status?: string;
      reply?: string;
      error?: string;
      runId?: string;
    };

    const durationMs = Date.now() - startTime;

    // Extract the agent's response
    const agentReply = response?.reply || "Task completed (no summary provided)";
    const summary =
      agentReply.length > 5000 ? agentReply.slice(0, 5000) + "... (truncated)" : agentReply;

    // Update Supabase with success
    await db
      .from("tasks")
      .update({
        status: "review",
        execution_session_key: sessionKey,
        execution_completed_at: new Date().toISOString(),
        execution_duration_ms: durationMs,
        execution_result: summary,
        agent_summary: summary,
      })
      .eq("id", task.id);

    if (activeTask) {
      activeTask.status = "completed";
      activeTask.progress = "Task completed successfully";
    }

    console.log(`[task-api] Task completed: ${task.title} (${durationMs}ms)`);

    // Clean up after a delay
    setTimeout(() => activeTasks.delete(task.id), 60000);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`[task-api] Task failed: ${task.title}`, errorMessage);

    // Update Supabase with failure
    await db
      .from("tasks")
      .update({
        status: "failed",
        execution_session_key: sessionKey,
        execution_completed_at: new Date().toISOString(),
        execution_duration_ms: durationMs,
        execution_error: errorMessage,
      })
      .eq("id", task.id);

    if (activeTask) {
      activeTask.status = "failed";
      activeTask.progress = `Failed: ${errorMessage}`;
    }

    setTimeout(() => activeTasks.delete(task.id), 60000);
  }
}

export default {
  handleTaskRequest,
};

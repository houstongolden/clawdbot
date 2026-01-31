/**
 * Tasks API for Myobot
 *
 * HTTP endpoints for task management:
 * - List tasks assigned to this gateway
 * - Claim pending tasks
 * - Execute tasks
 * - Report completion/failure
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getAssignedTasks,
  claimTask,
  startTask,
  completeTask,
  failTask,
  Task,
} from "./supabase-sync.js";

// Store gateway ID (set during initialization)
let gatewayId: string | null = null;

/**
 * Set the gateway ID for task operations
 */
export function setGatewayId(id: string): void {
  gatewayId = id;
  console.log("[tasks-api] Gateway ID set:", id);
}

/**
 * Get the current gateway ID
 */
export function getGatewayId(): string | null {
  return gatewayId;
}

// ============================================================================
// HTTP Handlers
// ============================================================================

/**
 * Parse JSON body from request
 */
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Handle tasks API requests
 */
export async function handleTasksRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle /api/tasks routes
  if (!url.pathname.startsWith("/api/tasks")) {
    return false;
  }

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Check gateway ID is set
  if (!gatewayId) {
    sendJson(res, 500, { error: "Gateway not initialized" });
    return true;
  }

  try {
    // GET /api/tasks - List assigned tasks
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const tasks = await getAssignedTasks(gatewayId);
      sendJson(res, 200, { tasks });
      return true;
    }

    // POST /api/tasks/:id/claim - Claim a task
    const claimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);
    if (req.method === "POST" && claimMatch) {
      const taskId = claimMatch[1];
      const success = await claimTask(taskId, gatewayId);

      if (success) {
        sendJson(res, 200, { claimed: true, taskId });
      } else {
        sendJson(res, 409, { error: "Could not claim task (may already be claimed)" });
      }
      return true;
    }

    // POST /api/tasks/:id/start - Mark task as running
    const startMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/start$/);
    if (req.method === "POST" && startMatch) {
      const taskId = startMatch[1];
      const body = await parseBody<{ sessionKey: string }>(req);

      if (!body.sessionKey) {
        sendJson(res, 400, { error: "sessionKey is required" });
        return true;
      }

      const success = await startTask(taskId, body.sessionKey);

      if (success) {
        sendJson(res, 200, { started: true, taskId });
      } else {
        sendJson(res, 500, { error: "Failed to start task" });
      }
      return true;
    }

    // POST /api/tasks/:id/complete - Mark task as complete
    const completeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (req.method === "POST" && completeMatch) {
      const taskId = completeMatch[1];
      const body = await parseBody<{
        result: string;
        artifacts?: Task["artifacts"];
      }>(req);

      if (!body.result) {
        sendJson(res, 400, { error: "result is required" });
        return true;
      }

      const success = await completeTask(taskId, body.result, body.artifacts);

      if (success) {
        sendJson(res, 200, { completed: true, taskId });
      } else {
        sendJson(res, 500, { error: "Failed to complete task" });
      }
      return true;
    }

    // POST /api/tasks/:id/fail - Mark task as failed
    const failMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/fail$/);
    if (req.method === "POST" && failMatch) {
      const taskId = failMatch[1];
      const body = await parseBody<{ error: string }>(req);

      if (!body.error) {
        sendJson(res, 400, { error: "error message is required" });
        return true;
      }

      const success = await failTask(taskId, body.error);

      if (success) {
        sendJson(res, 200, { failed: true, taskId });
      } else {
        sendJson(res, 500, { error: "Failed to update task" });
      }
      return true;
    }

    // 404 for unmatched routes
    sendJson(res, 404, { error: "Not found" });
    return true;
  } catch (error) {
    console.error("[tasks-api] Error:", error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal error",
    });
    return true;
  }
}

export default {
  setGatewayId,
  getGatewayId,
  handleTasksRequest,
};

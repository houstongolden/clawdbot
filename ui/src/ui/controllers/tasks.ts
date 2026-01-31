/**
 * Tasks Controller for Myo.ai Integration
 * 
 * Loads tasks from the gateway's task API and handles execution.
 */

import type { AppViewState } from "../app-view-state.js";

const API_BASE = ""; // Same origin

interface TaskApiResponse {
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    startedAt: number;
    progress?: string;
  }>;
}

interface ClaimResponse {
  success: boolean;
  taskId: string;
  status: string;
  error?: string;
}

/**
 * Load tasks from the gateway API
 */
export async function loadTasks(state: AppViewState): Promise<void> {
  state.tasksLoading = true;
  state.tasksError = null;

  try {
    // Load active executions from gateway
    const response = await fetch(`${API_BASE}/api/tasks/status`, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to load tasks: ${response.status}`);
    }

    const data: TaskApiResponse = await response.json();
    
    // Map to active executions format
    state.activeExecutions = data.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      startedAt: t.startedAt,
      progress: t.progress,
    }));

    // TODO: Load tasks from Supabase when connected
    // For now, show only active executions from gateway
    // Tasks list would come from Myo.ai cloud via WebSocket or polling

  } catch (err) {
    console.error("[tasks] Load error:", err);
    state.tasksError = err instanceof Error ? err.message : "Failed to load tasks";
  } finally {
    state.tasksLoading = false;
  }
}

/**
 * Claim and execute a task
 */
export async function claimTask(state: AppViewState, taskId: string): Promise<void> {
  state.tasksLoading = true;
  state.tasksError = null;

  try {
    const response = await fetch(`${API_BASE}/api/tasks/${taskId}/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer local", // TODO: Use actual token
      },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to claim task: ${response.status}`);
    }

    const data: ClaimResponse = await response.json();
    
    if (!data.success) {
      throw new Error(data.error || "Failed to claim task");
    }

    // Refresh task list
    await loadTasks(state);

  } catch (err) {
    console.error("[tasks] Claim error:", err);
    state.tasksError = err instanceof Error ? err.message : "Failed to claim task";
    state.tasksLoading = false;
  }
}

/**
 * View task execution result
 */
export function viewTaskResult(state: AppViewState, taskId: string): void {
  // Find the task
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    state.tasksError = "Task not found";
    return;
  }

  // For now, log the result
  // TODO: Show in a modal or sidebar
  if (task.execution_result) {
    console.log("[tasks] Result for", taskId, ":", task.execution_result);
    alert(`Task Result:\n\n${task.execution_result}`);
  } else if (task.execution_error) {
    console.error("[tasks] Error for", taskId, ":", task.execution_error);
    alert(`Task Error:\n\n${task.execution_error}`);
  }
}

/**
 * Subscribe to task progress via SSE
 */
export function subscribeToTaskProgress(
  taskId: string,
  onProgress: (progress: string) => void,
  onComplete: () => void,
  onError: (error: string) => void
): () => void {
  const eventSource = new EventSource(`${API_BASE}/api/tasks/${taskId}/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case "progress":
          if (data.task?.progress) {
            onProgress(data.task.progress);
          }
          break;
        case "done":
        case "completed":
          onComplete();
          eventSource.close();
          break;
        case "error":
          onError(data.error || "Unknown error");
          eventSource.close();
          break;
      }
    } catch (err) {
      console.error("[tasks] SSE parse error:", err);
    }
  };

  eventSource.onerror = () => {
    onError("Connection lost");
    eventSource.close();
  };

  // Return cleanup function
  return () => eventSource.close();
}

export default {
  loadTasks,
  claimTask,
  viewTaskResult,
  subscribeToTaskProgress,
};

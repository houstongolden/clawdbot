import { html, nothing } from "lit";
import { icons } from "../icons.js";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "queued" | "in_progress" | "review" | "completed" | "failed";
  priority?: "low" | "medium" | "high" | "urgent";
  due_date?: string;
  assigned_gateway_id?: string;
  execution_started_at?: string;
  execution_completed_at?: string;
  execution_duration_ms?: number;
  execution_result?: string;
  execution_error?: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveExecution {
  id: string;
  title: string;
  status: "claimed" | "executing" | "completed" | "failed";
  startedAt: number;
  progress?: string;
}

export type TasksViewProps = {
  tasks: Task[];
  activeExecutions: ActiveExecution[];
  loading: boolean;
  error: string | null;
  gatewayConnected: boolean;
  // Event handlers
  onRefresh: () => void;
  onClaimTask: (taskId: string) => void;
  onViewResult: (taskId: string) => void;
};

/**
 * Get status badge color
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "pending":
      return "#6b7280"; // gray
    case "queued":
      return "#3b82f6"; // blue
    case "in_progress":
    case "executing":
    case "claimed":
      return "#f59e0b"; // amber
    case "review":
      return "#8b5cf6"; // purple
    case "completed":
      return "#10b981"; // green
    case "failed":
      return "#ef4444"; // red
    default:
      return "#6b7280";
  }
}

/**
 * Get priority badge
 */
function getPriorityBadge(priority?: string) {
  if (!priority) return nothing;
  
  const colors: Record<string, string> = {
    low: "#6b7280",
    medium: "#3b82f6",
    high: "#f59e0b",
    urgent: "#ef4444",
  };
  
  return html`
    <span class="priority-badge" style="background: ${colors[priority] || colors.medium}">
      ${priority}
    </span>
  `;
}

/**
 * Format relative time
 */
function formatRelativeTime(dateString?: string): string {
  if (!dateString) return "";
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString();
}

/**
 * Format duration
 */
function formatDuration(ms?: number): string {
  if (!ms) return "";
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Render active execution card
 */
function renderActiveExecution(execution: ActiveExecution) {
  const isRunning = execution.status === "claimed" || execution.status === "executing";
  
  return html`
    <div class="execution-card ${isRunning ? "executing" : execution.status}">
      <div class="execution-header">
        <span class="execution-status">
          ${isRunning ? html`<span class="spinner"></span>` : nothing}
          ${execution.status}
        </span>
        <span class="execution-time">
          ${formatRelativeTime(new Date(execution.startedAt).toISOString())}
        </span>
      </div>
      <div class="execution-title">${execution.title}</div>
      ${execution.progress 
        ? html`<div class="execution-progress">${execution.progress}</div>` 
        : nothing
      }
    </div>
  `;
}

/**
 * Render task card
 */
function renderTaskCard(
  task: Task,
  onClaim: (id: string) => void,
  onViewResult: (id: string) => void
) {
  const canClaim = ["pending", "queued"].includes(task.status);
  const hasResult = task.execution_result || task.execution_error;
  
  return html`
    <div class="task-card ${task.status}">
      <div class="task-header">
        <span 
          class="task-status" 
          style="background: ${getStatusColor(task.status)}"
        >
          ${task.status.replace("_", " ")}
        </span>
        ${getPriorityBadge(task.priority)}
        <span class="task-time">${formatRelativeTime(task.updated_at)}</span>
      </div>
      
      <div class="task-title">${task.title}</div>
      
      ${task.description 
        ? html`<div class="task-description">${task.description}</div>` 
        : nothing
      }
      
      ${task.execution_duration_ms 
        ? html`
            <div class="task-duration">
              ⏱️ Completed in ${formatDuration(task.execution_duration_ms)}
            </div>
          ` 
        : nothing
      }
      
      ${task.execution_error 
        ? html`
            <div class="task-error">
              ❌ ${task.execution_error}
            </div>
          ` 
        : nothing
      }
      
      <div class="task-actions">
        ${canClaim 
          ? html`
              <button 
                class="btn btn-primary btn-sm"
                @click=${() => onClaim(task.id)}
              >
                ${icons.play} Run Task
              </button>
            ` 
          : nothing
        }
        ${hasResult 
          ? html`
              <button 
                class="btn btn-secondary btn-sm"
                @click=${() => onViewResult(task.id)}
              >
                ${icons.file} View Result
              </button>
            ` 
          : nothing
        }
      </div>
    </div>
  `;
}

/**
 * Render the Tasks view
 */
export function renderTasks(props: TasksViewProps) {
  const { 
    tasks, 
    activeExecutions, 
    loading, 
    error, 
    gatewayConnected,
    onRefresh, 
    onClaimTask, 
    onViewResult 
  } = props;

  // Split tasks by status
  const runningTasks = tasks.filter(t => t.status === "in_progress");
  const pendingTasks = tasks.filter(t => ["pending", "queued"].includes(t.status));
  const reviewTasks = tasks.filter(t => t.status === "review");
  const completedTasks = tasks.filter(t => ["completed", "failed"].includes(t.status)).slice(0, 10);

  return html`
    <div class="tasks-view">
      <div class="tasks-header">
        <h2>Tasks</h2>
        <div class="tasks-actions">
          <span class="connection-status ${gatewayConnected ? "connected" : "disconnected"}">
            ${gatewayConnected ? "🟢 Connected" : "🔴 Disconnected"}
          </span>
          <button 
            class="btn btn-secondary btn-sm"
            @click=${onRefresh}
            ?disabled=${loading}
          >
            ${loading ? html`<span class="spinner"></span>` : icons.refresh}
            Refresh
          </button>
        </div>
      </div>

      ${error 
        ? html`<div class="tasks-error">${error}</div>` 
        : nothing
      }

      <!-- Active Executions -->
      ${activeExecutions.length > 0 
        ? html`
            <div class="tasks-section">
              <h3>🔄 Active Executions</h3>
              <div class="executions-list">
                ${activeExecutions.map(e => renderActiveExecution(e))}
              </div>
            </div>
          ` 
        : nothing
      }

      <!-- Running Tasks -->
      ${runningTasks.length > 0 
        ? html`
            <div class="tasks-section">
              <h3>🏃 Running (${runningTasks.length})</h3>
              <div class="tasks-list">
                ${runningTasks.map(t => renderTaskCard(t, onClaimTask, onViewResult))}
              </div>
            </div>
          ` 
        : nothing
      }

      <!-- Pending Tasks -->
      <div class="tasks-section">
        <h3>📋 Pending (${pendingTasks.length})</h3>
        ${pendingTasks.length > 0 
          ? html`
              <div class="tasks-list">
                ${pendingTasks.map(t => renderTaskCard(t, onClaimTask, onViewResult))}
              </div>
            `
          : html`<div class="empty-state">No pending tasks. Create tasks in Myo.ai.</div>`
        }
      </div>

      <!-- Review Tasks -->
      ${reviewTasks.length > 0 
        ? html`
            <div class="tasks-section">
              <h3>👀 Needs Review (${reviewTasks.length})</h3>
              <div class="tasks-list">
                ${reviewTasks.map(t => renderTaskCard(t, onClaimTask, onViewResult))}
              </div>
            </div>
          ` 
        : nothing
      }

      <!-- Recent Completed -->
      ${completedTasks.length > 0 
        ? html`
            <div class="tasks-section">
              <h3>✅ Recent Completed</h3>
              <div class="tasks-list">
                ${completedTasks.map(t => renderTaskCard(t, onClaimTask, onViewResult))}
              </div>
            </div>
          ` 
        : nothing
      }
    </div>

    <style>
      .tasks-view {
        padding: 1rem;
        max-width: 800px;
        margin: 0 auto;
      }

      .tasks-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
      }

      .tasks-header h2 {
        margin: 0;
        font-size: 1.5rem;
      }

      .tasks-actions {
        display: flex;
        gap: 0.75rem;
        align-items: center;
      }

      .connection-status {
        font-size: 0.875rem;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
      }

      .connection-status.connected {
        background: rgba(16, 185, 129, 0.1);
        color: #10b981;
      }

      .connection-status.disconnected {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
      }

      .tasks-error {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
        padding: 0.75rem;
        border-radius: 6px;
        margin-bottom: 1rem;
      }

      .tasks-section {
        margin-bottom: 2rem;
      }

      .tasks-section h3 {
        font-size: 1rem;
        margin: 0 0 0.75rem 0;
        color: var(--text-secondary, #6b7280);
      }

      .tasks-list, .executions-list {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .task-card, .execution-card {
        background: var(--bg-secondary, #1a1a2e);
        border: 1px solid var(--border-color, #2d2d44);
        border-radius: 8px;
        padding: 1rem;
      }

      .task-card:hover {
        border-color: var(--primary-color, #3b82f6);
      }

      .task-header, .execution-header {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 0.5rem;
        flex-wrap: wrap;
      }

      .task-status, .execution-status {
        font-size: 0.75rem;
        padding: 0.125rem 0.5rem;
        border-radius: 9999px;
        color: white;
        text-transform: uppercase;
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }

      .priority-badge {
        font-size: 0.75rem;
        padding: 0.125rem 0.5rem;
        border-radius: 4px;
        color: white;
        text-transform: capitalize;
      }

      .task-time, .execution-time {
        font-size: 0.75rem;
        color: var(--text-muted, #9ca3af);
        margin-left: auto;
      }

      .task-title, .execution-title {
        font-weight: 500;
        margin-bottom: 0.25rem;
      }

      .task-description {
        font-size: 0.875rem;
        color: var(--text-secondary, #9ca3af);
        margin-bottom: 0.5rem;
        white-space: pre-wrap;
      }

      .task-duration {
        font-size: 0.75rem;
        color: var(--text-muted, #6b7280);
      }

      .task-error {
        font-size: 0.875rem;
        color: #ef4444;
        background: rgba(239, 68, 68, 0.1);
        padding: 0.5rem;
        border-radius: 4px;
        margin-top: 0.5rem;
      }

      .execution-progress {
        font-size: 0.875rem;
        color: var(--text-secondary, #9ca3af);
        font-style: italic;
      }

      .task-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.5rem 1rem;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        transition: all 0.15s;
      }

      .btn-sm {
        padding: 0.375rem 0.75rem;
        font-size: 0.8125rem;
      }

      .btn-primary {
        background: var(--primary-color, #3b82f6);
        color: white;
      }

      .btn-primary:hover {
        background: var(--primary-hover, #2563eb);
      }

      .btn-secondary {
        background: var(--bg-tertiary, #2d2d44);
        color: var(--text-primary, #e5e5e5);
      }

      .btn-secondary:hover {
        background: var(--bg-hover, #3d3d54);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .spinner {
        display: inline-block;
        width: 1em;
        height: 1em;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 0.75s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .empty-state {
        text-align: center;
        padding: 2rem;
        color: var(--text-muted, #6b7280);
        background: var(--bg-secondary, #1a1a2e);
        border-radius: 8px;
        border: 1px dashed var(--border-color, #2d2d44);
      }

      .execution-card.executing {
        border-color: #f59e0b;
        animation: pulse 2s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
      }
    </style>
  `;
}

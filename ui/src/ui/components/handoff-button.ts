import { html, nothing } from "lit";
import { icons } from "../icons.js";

export interface HandoffButtonProps {
  connected: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  onHandoff: () => void;
  onSync: () => void;
}

/**
 * Handoff to Cloud button component
 * Allows user to manually sync session and prepare for cloud handoff
 */
export function renderHandoffButton(props: HandoffButtonProps) {
  const { connected, syncing, lastSyncAt, onHandoff, onSync } = props;

  if (!connected) {
    return nothing;
  }

  const lastSyncText = lastSyncAt
    ? `Last sync: ${new Date(lastSyncAt).toLocaleTimeString()}`
    : "Not synced yet";

  return html`
    <div class="handoff-container">
      <div class="handoff-status">
        <span class="sync-indicator ${syncing ? "syncing" : ""}">
          ${syncing ? html`<span class="spinner-small"></span>` : "🔄"}
        </span>
        <span class="sync-text">${lastSyncText}</span>
      </div>
      
      <div class="handoff-actions">
        <button 
          class="btn btn-secondary btn-sm"
          @click=${onSync}
          ?disabled=${syncing}
          title="Sync current session to cloud"
        >
          ${syncing ? "Syncing..." : "Sync Now"}
        </button>
        
        <button 
          class="btn btn-primary btn-sm"
          @click=${onHandoff}
          ?disabled=${syncing}
          title="Hand off to cloud and close laptop safely"
        >
          ${icons.cloud || "☁️"} Hand Off to Cloud
        </button>
      </div>
    </div>

    <style>
      .handoff-container {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem;
        background: var(--bg-secondary, #1a1a2e);
        border: 1px solid var(--border-color, #2d2d44);
        border-radius: 8px;
        margin: 0.5rem 0;
      }

      .handoff-status {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
        color: var(--text-muted, #6b7280);
      }

      .sync-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.25rem;
        height: 1.25rem;
      }

      .sync-indicator.syncing {
        animation: pulse 1s infinite;
      }

      .handoff-actions {
        display: flex;
        gap: 0.5rem;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.5rem 0.75rem;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 500;
        transition: all 0.15s;
      }

      .btn-sm {
        padding: 0.375rem 0.625rem;
        font-size: 0.75rem;
      }

      .btn-primary {
        background: var(--primary-color, #3b82f6);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--primary-hover, #2563eb);
      }

      .btn-secondary {
        background: var(--bg-tertiary, #2d2d44);
        color: var(--text-primary, #e5e5e5);
      }

      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-hover, #3d3d54);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .spinner-small {
        display: inline-block;
        width: 0.75rem;
        height: 0.75rem;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 0.75s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    </style>
  `;
}

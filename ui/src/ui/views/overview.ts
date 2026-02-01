import { html, nothing } from "lit";

import type { GatewayHelloOk } from "../gateway";
import { formatAgo, formatDurationMs } from "../format";
import { formatNextRun } from "../presenter";
import type { UiSettings } from "../storage";
import type { GatewaySessionRow, LogEntry } from "../types";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  // Quick session preview (optional)
  recentSessions?: GatewaySessionRow[];
  // Quick log preview (optional)
  recentLogs?: LogEntry[];
  // Cloud sync / handoff
  sessionSyncing?: boolean;
  lastSessionSyncAt?: string | null;
  cloudConnected?: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  onSyncSession?: () => void;
  onHandoffToCloud?: () => void;
  onNavigateToSessions?: () => void;
  onNavigateToLogs?: () => void;
};

export function renderOverview(props: OverviewProps) {
  const snapshot = props.hello?.snapshot as
    | { uptimeMs?: number; policy?: { tickIntervalMs?: number } }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : "n/a";
  const authHint = (() => {
    if (props.connected || !props.lastError) return null;
    const lower = props.lastError.toLowerCase();
    const authFailed = lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) return null;
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    if (!hasToken && !hasPassword) {
      return html`
        <div class="muted" style="margin-top: 8px;">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px;">
            <span class="mono">openclaw dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px;">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px;">
        Auth failed. Re-copy a tokenized URL with
        <span class="mono">openclaw dashboard --no-open</span>, or update the token,
        then click Connect.
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `;
  })();
  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) return null;
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext !== false) return null;
    const lower = props.lastError.toLowerCase();
    if (!lower.includes("secure context") && !lower.includes("device identity required")) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px;">
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or
        open <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
        <div style="margin-top: 6px;">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  // Quick session status helper
  const getSessionStatus = (session: GatewaySessionRow) => {
    if (!session.updatedAt) return { status: "unknown", label: "Unknown", class: "muted" };
    const now = Date.now();
    const ageMs = now - session.updatedAt;
    if (ageMs < 60000) return { status: "active", label: "Active", class: "ok" }; // < 1 min
    if (ageMs < 300000) return { status: "idle", label: "Idle", class: "warn" }; // < 5 min
    return { status: "inactive", label: "Inactive", class: "muted" };
  };

  // Get recent sessions (max 5)
  const recentSessions = (props.recentSessions ?? []).slice(0, 5);

  return html`
    <!-- Status Hero Card -->
    <section class="status-hero ${props.connected ? "status-hero--connected" : "status-hero--disconnected"}">
      <div class="status-hero__indicator">
        <span class="status-hero__dot ${props.connected ? "status-hero__dot--ok" : "status-hero__dot--error"}"></span>
      </div>
      <div class="status-hero__content">
        <div class="status-hero__title">${props.connected ? "Gateway Running" : "Gateway Offline"}</div>
        <div class="status-hero__subtitle">
          ${props.connected 
            ? `Uptime: ${uptime} · Tick: ${tick}` 
            : props.lastError ?? "Not connected to gateway"}
        </div>
      </div>
      <div class="status-hero__actions">
        <button class="btn btn-sm" @click=${() => props.onRefresh()}>Refresh</button>
        ${!props.connected ? html`<button class="btn btn-sm btn-primary" @click=${() => props.onConnect()}>Connect</button>` : nothing}
      </div>
    </section>

    <!-- Health Metrics Grid -->
    <section class="grid grid-cols-4" style="margin-top: 18px;">
      <div class="card stat-card stat-card--compact">
        <div class="stat-label">Status</div>
        <div class="stat-value ${props.connected ? "ok" : "warn"}" style="font-size: 20px;">
          ${props.connected ? "● Online" : "○ Offline"}
        </div>
      </div>
      <div class="card stat-card stat-card--compact">
        <div class="stat-label">Sessions</div>
        <div class="stat-value" style="font-size: 20px;">${props.sessionsCount ?? "—"}</div>
      </div>
      <div class="card stat-card stat-card--compact">
        <div class="stat-label">Uptime</div>
        <div class="stat-value" style="font-size: 20px;">${uptime}</div>
      </div>
      <div class="card stat-card stat-card--compact">
        <div class="stat-label">Instances</div>
        <div class="stat-value" style="font-size: 20px;">${props.presenceCount}</div>
      </div>
    </section>

    <!-- Quick Session Preview -->
    ${recentSessions.length > 0 ? html`
    <section class="card" style="margin-top: 18px;">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Recent Sessions</div>
          <div class="card-sub">Active and recent session activity</div>
        </div>
        ${props.onNavigateToSessions ? html`
          <button class="btn btn-sm" @click=${props.onNavigateToSessions}>View All →</button>
        ` : nothing}
      </div>
      <div class="session-list" style="margin-top: 14px;">
        ${recentSessions.map(session => {
          const status = getSessionStatus(session);
          const displayName = session.displayName ?? session.label ?? session.key;
          const timeAgo = session.updatedAt ? formatAgo(session.updatedAt) : "n/a";
          return html`
            <div class="session-item">
              <div class="session-item__indicator">
                <span class="session-dot session-dot--${status.status}"></span>
              </div>
              <div class="session-item__info">
                <div class="session-item__name mono">${displayName}</div>
                <div class="session-item__meta muted">${session.kind} · ${timeAgo}</div>
              </div>
              <div class="session-item__status ${status.class}">${status.label}</div>
            </div>
          `;
        })}
      </div>
    </section>
    ` : nothing}

    <!-- Connection Settings (collapsible) -->
    <details class="card" style="margin-top: 18px;">
      <summary class="card-title" style="cursor: pointer; user-select: none;">
        Gateway Connection Settings
      </summary>
      <div class="card-sub" style="margin-top: 8px;">Where the dashboard connects and how it authenticates.</div>
      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span>WebSocket URL</span>
          <input
            .value=${props.settings.gatewayUrl}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              props.onSettingsChange({ ...props.settings, gatewayUrl: v });
            }}
            placeholder="ws://100.x.y.z:18789"
          />
        </label>
        <label class="field">
          <span>Gateway Token</span>
          <input
            .value=${props.settings.token}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              props.onSettingsChange({ ...props.settings, token: v });
            }}
            placeholder="OPENCLAW_GATEWAY_TOKEN"
          />
        </label>
        <label class="field">
          <span>Password (not stored)</span>
          <input
            type="password"
            .value=${props.password}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              props.onPasswordChange(v);
            }}
            placeholder="system or shared password"
          />
        </label>
        <label class="field">
          <span>Default Session Key</span>
          <input
            .value=${props.settings.sessionKey}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              props.onSessionKeyChange(v);
            }}
          />
        </label>
      </div>
      <div class="row" style="margin-top: 14px;">
        <button class="btn" @click=${() => props.onConnect()}>Connect</button>
        <span class="muted">Click Connect to apply connection changes.</span>
      </div>
      ${props.lastError && !props.connected
        ? html`<div class="callout danger" style="margin-top: 14px;">
            <div>${props.lastError}</div>
            ${authHint ?? ""}
            ${insecureContextHint ?? ""}
          </div>`
        : nothing}
    </details>

    <!-- Additional Stats Row -->
    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">Cron Jobs</div>
        <div class="stat-value">
          ${props.cronEnabled == null
            ? "n/a"
            : props.cronEnabled
              ? "Enabled"
              : "Disabled"}
        </div>
        <div class="muted">Next wake ${formatNextRun(props.cronNext)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Last Channels Refresh</div>
        <div class="stat-value" style="font-size: 18px;">
          ${props.lastChannelsRefresh ? formatAgo(props.lastChannelsRefresh) : "n/a"}
        </div>
        <div class="muted">Channel status poll time</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Tick Interval</div>
        <div class="stat-value" style="font-size: 18px;">${tick}</div>
        <div class="muted">Gateway heartbeat frequency</div>
      </div>
    </section>

    <!-- Cloud Sync Section -->
    <section class="card" style="margin-top: 18px;">
      <div class="card-title">☁️ Cloud Sync</div>
      <div class="card-sub">Sync sessions to Myo.ai for seamless handoff when closing your laptop.</div>
      <div style="margin-top: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <div class="stat-label">Last Sync</div>
          <div class="stat-value" style="font-size: 0.875rem;">
            ${props.lastSessionSyncAt 
              ? formatAgo(new Date(props.lastSessionSyncAt).getTime()) 
              : "Never"}
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button 
            class="btn btn-secondary"
            @click=${props.onSyncSession}
            ?disabled=${props.sessionSyncing || !props.connected}
            style="padding: 8px 12px; font-size: 0.8125rem;"
          >
            ${props.sessionSyncing ? "Syncing..." : "🔄 Sync Now"}
          </button>
          <button 
            class="btn btn-primary"
            @click=${props.onHandoffToCloud}
            ?disabled=${props.sessionSyncing || !props.connected}
            style="padding: 8px 12px; font-size: 0.8125rem;"
          >
            ☁️ Hand Off to Cloud
          </button>
        </div>
      </div>
      <div class="muted" style="margin-top: 8px; font-size: 0.75rem;">
        Hand off when you're about to close your laptop. Myo will continue in the cloud and notify you of updates.
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Notes</div>
      <div class="card-sub">Quick reminders for remote control setups.</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">Tailscale serve</div>
          <div class="muted">
            Prefer serve mode to keep the gateway on loopback with tailnet auth.
          </div>
        </div>
        <div>
          <div class="note-title">Session hygiene</div>
          <div class="muted">Use /new or sessions.patch to reset context.</div>
        </div>
        <div>
          <div class="note-title">Cron reminders</div>
          <div class="muted">Use isolated sessions for recurring runs.</div>
        </div>
      </div>
    </section>
  `;
}

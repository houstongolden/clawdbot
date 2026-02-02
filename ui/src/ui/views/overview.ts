import { html, nothing } from "lit";

import type { GatewayHelloOk } from "../gateway";
import { formatAgo, formatDurationMs } from "../format";
import { formatNextRun } from "../presenter";
import type { UiSettings } from "../storage";
import type { GatewaySessionRow, LogEntry, CronJob } from "../types";

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
  cronJobs?: CronJob[];
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
  onNavigateToCron?: () => void;
};

// Icons
const icons = {
  refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  connect: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  sessions: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  arrow: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  cloud: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  sync: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  settings: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  logs: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  radio: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>`,
  cron: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  channel: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
};

export function renderOverview(props: OverviewProps) {
  const snapshot = props.hello?.snapshot as
    | { uptimeMs?: number; policy?: { tickIntervalMs?: number }; version?: string }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "—";
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : "—";
  const version = snapshot?.version ?? "—";

  // Quick session status helper
  const getSessionStatus = (session: GatewaySessionRow) => {
    if (!session.updatedAt) return { status: "inactive" as const, label: "Unknown" };
    const now = Date.now();
    const ageMs = now - session.updatedAt;
    if (ageMs < 60000) return { status: "active" as const, label: "Active" };
    if (ageMs < 300000) return { status: "idle" as const, label: "Idle" };
    return { status: "inactive" as const, label: "Inactive" };
  };

  // Get recent sessions (max 5)
  const recentSessions = (props.recentSessions ?? []).slice(0, 5);
  const activeSessions = recentSessions.filter(s => {
    if (!s.updatedAt) return false;
    return Date.now() - s.updatedAt < 300000; // < 5min
  }).length;

  // Get cron jobs count
  const cronJobsCount = props.cronJobs?.length ?? 0;

  // Auth hints for connection errors
  const authHint = (() => {
    if (props.connected || !props.lastError) return null;
    const lower = props.lastError.toLowerCase();
    const authFailed = lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) return null;
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    if (!hasToken && !hasPassword) {
      return html`
        <div class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.5;">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 8px; font-family: var(--mono); font-size: 11px;">
            <code>openclaw dashboard --no-open</code> → tokenized URL
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 10px; font-size: 12px;">
        Auth failed. Re-copy a tokenized URL or update the token.
      </div>
    `;
  })();

  return html`
    <!-- Status Hero Card -->
    <section class="status-hero ${props.connected ? "status-hero--connected" : "status-hero--disconnected"}">
      <div class="status-hero__indicator">
        <span class="status-hero__dot ${props.connected ? "status-hero__dot--ok" : "status-hero__dot--error"}"></span>
      </div>
      <div class="status-hero__content">
        <div class="status-hero__title">${props.connected ? "Gateway Online" : "Gateway Offline"}</div>
        <div class="status-hero__subtitle">
          ${props.connected 
            ? html`
                <span>Uptime: ${uptime}</span>
                <span class="divider"></span>
                <span>Tick: ${tick}</span>
                ${version !== "—" ? html`<span class="divider"></span><span>v${version}</span>` : nothing}
              ` 
            : props.lastError ?? "Unable to connect to gateway"}
        </div>
      </div>
      <div class="status-hero__actions">
        <button class="btn-control" @click=${() => props.onRefresh()} title="Refresh status">
          ${icons.refresh}
          <span>Refresh</span>
        </button>
        ${!props.connected ? html`
          <button class="btn-control btn-control--primary" @click=${() => props.onConnect()}>
            ${icons.connect}
            <span>Connect</span>
          </button>
        ` : nothing}
      </div>
    </section>

    <!-- Health Metrics Grid -->
    <section class="dashboard-grid dashboard-grid--4" style="margin-top: 20px;">
      <div class="stat-card ${props.connected ? 'stat-card--ok' : 'stat-card--danger'}">
        <div class="stat-label">Status</div>
        <div class="stat-value ${props.connected ? 'ok' : 'danger'}">
          ${props.connected ? "Online" : "Offline"}
        </div>
        <div class="stat-sub">${props.connected ? "All systems operational" : "Connection unavailable"}</div>
      </div>
      <div class="stat-card ${activeSessions > 0 ? 'stat-card--accent' : ''}">
        <div class="stat-label">Active Sessions</div>
        <div class="stat-value">${activeSessions}<span style="font-size: 14px; font-weight: 500; color: var(--muted);"> / ${props.sessionsCount ?? 0}</span></div>
        <div class="stat-sub">Sessions active in last 5m</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value stat-value--sm">${uptime}</div>
        <div class="stat-sub">Since last restart</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${props.presenceCount}</div>
        <div class="stat-sub">Connected clients</div>
      </div>
    </section>

    <!-- Quick Actions -->
    <section class="dashboard-grid dashboard-grid--3" style="margin-top: 20px;">
      <div class="action-card" @click=${props.onNavigateToSessions}>
        <div class="action-card__icon">${icons.sessions}</div>
        <div class="action-card__content">
          <div class="action-card__title">Sessions</div>
          <div class="action-card__desc">View and manage active sessions</div>
        </div>
        <div class="action-card__arrow">${icons.arrow}</div>
      </div>
      <div class="action-card" @click=${props.onNavigateToLogs}>
        <div class="action-card__icon">${icons.logs}</div>
        <div class="action-card__content">
          <div class="action-card__title">Logs</div>
          <div class="action-card__desc">Live streaming gateway logs</div>
        </div>
        <div class="action-card__arrow">${icons.arrow}</div>
      </div>
      <div class="action-card" @click=${props.onNavigateToCron}>
        <div class="action-card__icon">${icons.cron}</div>
        <div class="action-card__content">
          <div class="action-card__title">Cron Jobs</div>
          <div class="action-card__desc">${cronJobsCount} scheduled ${cronJobsCount === 1 ? "task" : "tasks"}</div>
        </div>
        <div class="action-card__arrow">${icons.arrow}</div>
      </div>
    </section>

    <!-- Recent Sessions Preview -->
    ${recentSessions.length > 0 ? html`
    <section class="card" style="margin-top: 20px;">
      <div class="section-header">
        <div class="section-title">Recent Sessions</div>
        ${props.onNavigateToSessions ? html`
          <span class="section-action" @click=${props.onNavigateToSessions}>View All →</span>
        ` : nothing}
      </div>
      <div class="sessions-grid">
        ${recentSessions.map(session => {
          const status = getSessionStatus(session);
          const displayName = session.displayName ?? session.label ?? session.key;
          const timeAgo = session.updatedAt ? formatAgo(session.updatedAt) : "—";
          return html`
            <div class="session-card session-card--${status.status}">
              <div class="session-card__status">
                <span class="session-card__dot session-card__dot--${status.status}"></span>
              </div>
              <div class="session-card__info">
                <div class="session-card__name mono">${displayName}</div>
                <div class="session-card__meta">
                  <span>${session.kind}</span>
                  <span class="session-card__meta-divider"></span>
                  <span>${timeAgo}</span>
                </div>
              </div>
              <div class="session-card__actions">
                <span class="session-card__badge session-card__badge--${status.status}">${status.label}</span>
              </div>
            </div>
          `;
        })}
      </div>
    </section>
    ` : nothing}

    <!-- Stats Row -->
    <section class="dashboard-grid dashboard-grid--3" style="margin-top: 20px;">
      <div class="stat-card">
        <div class="stat-label">Cron Status</div>
        <div class="stat-value stat-value--sm">
          ${props.cronEnabled == null
            ? "—"
            : props.cronEnabled
              ? "Enabled"
              : "Disabled"}
        </div>
        <div class="stat-sub">Next: ${formatNextRun(props.cronNext)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Channels Refresh</div>
        <div class="stat-value stat-value--sm">
          ${props.lastChannelsRefresh ? formatAgo(props.lastChannelsRefresh) : "—"}
        </div>
        <div class="stat-sub">Last channel status poll</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tick Interval</div>
        <div class="stat-value stat-value--sm">${tick}</div>
        <div class="stat-sub">Gateway heartbeat rate</div>
      </div>
    </section>

    <!-- Cloud Sync Section -->
    <section class="card" style="margin-top: 20px;">
      <div class="section-header">
        <div class="section-title">☁️ Cloud Sync</div>
      </div>
      <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <div class="stat-label">Last Sync</div>
          <div style="font-size: 15px; font-weight: 600; margin-top: 4px; color: var(--text);">
            ${props.lastSessionSyncAt 
              ? formatAgo(new Date(props.lastSessionSyncAt).getTime()) 
              : "Never"}
          </div>
          <div class="stat-sub" style="margin-top: 4px;">
            Sync sessions to Myo.ai for seamless handoff when closing your laptop.
          </div>
        </div>
        <div style="display: flex; gap: 10px;">
          <button 
            class="btn-control"
            @click=${props.onSyncSession}
            ?disabled=${props.sessionSyncing || !props.connected}
          >
            ${icons.sync}
            <span>${props.sessionSyncing ? "Syncing..." : "Sync Now"}</span>
          </button>
          <button 
            class="btn-control btn-control--primary"
            @click=${props.onHandoffToCloud}
            ?disabled=${props.sessionSyncing || !props.connected}
          >
            ${icons.cloud}
            <span>Hand Off</span>
          </button>
        </div>
      </div>
    </section>

    <!-- Connection Settings (collapsible) -->
    <details class="card" style="margin-top: 20px;">
      <summary class="section-title" style="cursor: pointer; user-select: none; padding: 4px 0;">
        ⚙️ Gateway Connection Settings
      </summary>
      <div class="card-sub" style="margin-top: 8px;">Configure gateway connection and authentication.</div>
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
          <span>Password</span>
          <input
            type="password"
            .value=${props.password}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              props.onPasswordChange(v);
            }}
            placeholder="System or shared password"
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
      <div class="row" style="margin-top: 16px;">
        <button class="btn-control btn-control--primary" @click=${() => props.onConnect()}>
          ${icons.connect}
          <span>Connect</span>
        </button>
        <span class="muted" style="font-size: 12px;">Apply connection changes</span>
      </div>
      ${props.lastError && !props.connected
        ? html`<div class="callout danger" style="margin-top: 16px;">
            <div>${props.lastError}</div>
            ${authHint ?? ""}
          </div>`
        : nothing}
    </details>
  `;
}

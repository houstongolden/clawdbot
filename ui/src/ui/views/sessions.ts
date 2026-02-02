import { html, nothing } from "lit";

import { formatAgo } from "../format";
import { formatSessionTokens } from "../presenter";
import { pathForTab } from "../navigation";
import type { GatewaySessionRow, SessionsListResult } from "../types";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  selectedSession: string | null;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onDelete: (key: string) => void;
  onSelectSession: (key: string | null) => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off" },
  { value: "on", label: "on" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

// Icons
const icons = {
  refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  search: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  chat: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  x: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  filter: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
};

function normalizeProviderId(provider?: string | null): string {
  if (!provider) return "";
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") return "zai";
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) return value;
  if (!value || value === "off") return value;
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) return null;
  if (!isBinary) return value;
  if (value === "on") return "low";
  return value;
}

type SessionStatus = "active" | "idle" | "inactive";

function getSessionStatus(updatedAt: number | null): { status: SessionStatus; label: string } {
  if (!updatedAt) return { status: "inactive", label: "Unknown" };
  const now = Date.now();
  const ageMs = now - updatedAt;
  if (ageMs < 60000) return { status: "active", label: "Active" };
  if (ageMs < 300000) return { status: "idle", label: "Idle" };
  return { status: "inactive", label: "Inactive" };
}

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  const selectedRow = props.selectedSession 
    ? rows.find(r => r.key === props.selectedSession) 
    : null;

  // Stats
  const activeCount = rows.filter(r => {
    if (!r.updatedAt) return false;
    return Date.now() - r.updatedAt < 60000;
  }).length;
  
  const idleCount = rows.filter(r => {
    if (!r.updatedAt) return false;
    const age = Date.now() - r.updatedAt;
    return age >= 60000 && age < 300000;
  }).length;

  return html`
    <div class="sessions-layout">
      <!-- Sessions List Panel -->
      <section class="sessions-list-panel">
        <!-- Header -->
        <div class="sessions-list-header">
          <div class="sessions-list-header__info">
            <div class="sessions-list-title">Sessions</div>
            <div class="sessions-list-stats">
              <span class="info-pill info-pill--ok">${activeCount} active</span>
              <span class="info-pill info-pill--warn">${idleCount} idle</span>
              <span class="info-pill">${rows.length} total</span>
            </div>
          </div>
          <button class="btn-control" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icons.refresh}
            <span>${props.loading ? "Loading…" : "Refresh"}</span>
          </button>
        </div>

        <!-- Filters -->
        <div class="sessions-filters">
          <div class="sessions-filter-row">
            <label class="sessions-filter-field">
              <span>Active within</span>
              <div class="sessions-filter-input-group">
                <input
                  type="number"
                  .value=${props.activeMinutes}
                  @input=${(e: Event) =>
                    props.onFiltersChange({
                      activeMinutes: (e.target as HTMLInputElement).value,
                      limit: props.limit,
                      includeGlobal: props.includeGlobal,
                      includeUnknown: props.includeUnknown,
                    })}
                />
                <span class="sessions-filter-suffix">min</span>
              </div>
            </label>
            <label class="sessions-filter-field">
              <span>Limit</span>
              <input
                type="number"
                .value=${props.limit}
                @input=${(e: Event) =>
                  props.onFiltersChange({
                    activeMinutes: props.activeMinutes,
                    limit: (e.target as HTMLInputElement).value,
                    includeGlobal: props.includeGlobal,
                    includeUnknown: props.includeUnknown,
                  })}
              />
            </label>
          </div>
          <div class="sessions-filter-toggles">
            <label class="sessions-toggle-chip ${props.includeGlobal ? 'active' : ''}">
              <input
                type="checkbox"
                .checked=${props.includeGlobal}
                @change=${(e: Event) =>
                  props.onFiltersChange({
                    activeMinutes: props.activeMinutes,
                    limit: props.limit,
                    includeGlobal: (e.target as HTMLInputElement).checked,
                    includeUnknown: props.includeUnknown,
                  })}
              />
              <span>Global</span>
            </label>
            <label class="sessions-toggle-chip ${props.includeUnknown ? 'active' : ''}">
              <input
                type="checkbox"
                .checked=${props.includeUnknown}
                @change=${(e: Event) =>
                  props.onFiltersChange({
                    activeMinutes: props.activeMinutes,
                    limit: props.limit,
                    includeGlobal: props.includeGlobal,
                    includeUnknown: (e.target as HTMLInputElement).checked,
                  })}
              />
              <span>Unknown</span>
            </label>
          </div>
        </div>

        ${props.error
          ? html`<div class="callout danger" style="margin: 12px;">${props.error}</div>`
          : nothing}

        <!-- Sessions List -->
        <div class="sessions-list-content">
          ${rows.length === 0
            ? html`
                <div class="sessions-empty">
                  <div class="sessions-empty__icon">📭</div>
                  <div class="sessions-empty__text">No sessions found</div>
                  <div class="sessions-empty__sub">Try adjusting your filters</div>
                </div>
              `
            : rows.map((row) => renderSessionCard(row, props))}
        </div>

        ${props.result?.path ? html`
          <div class="sessions-footer">
            <span class="mono muted" style="font-size: 11px;">Store: ${props.result.path}</span>
          </div>
        ` : nothing}
      </section>

      <!-- Session Detail Panel -->
      ${selectedRow ? html`
        <section class="session-detail-panel">
          ${renderSessionDetail(selectedRow, props)}
        </section>
      ` : html`
        <section class="session-detail-panel session-detail-panel--empty">
          <div class="session-detail-empty">
            <div class="session-detail-empty__icon">👈</div>
            <div class="session-detail-empty__text">Select a session</div>
            <div class="session-detail-empty__sub">Click on a session to view details</div>
          </div>
        </section>
      `}
    </div>
  `;
}

function renderSessionCard(row: GatewaySessionRow, props: SessionsProps) {
  const status = getSessionStatus(row.updatedAt);
  const displayName = row.displayName ?? row.label ?? row.key;
  const timeAgo = row.updatedAt ? formatAgo(row.updatedAt) : "—";
  const isSelected = props.selectedSession === row.key;
  const chatUrl = row.kind !== "global"
    ? `${pathForTab("chat", props.basePath)}?session=${encodeURIComponent(row.key)}`
    : null;

  return html`
    <div 
      class="session-card ${isSelected ? 'session-card--selected' : ''} session-card--${status.status}"
      @click=${() => props.onSelectSession(row.key)}
    >
      <div class="session-card__status">
        <span class="session-card__dot session-card__dot--${status.status}"></span>
      </div>
      <div class="session-card__info">
        <div class="session-card__name">
          ${chatUrl 
            ? html`<a href=${chatUrl} class="session-card__link" @click=${(e: Event) => e.stopPropagation()}>${displayName}</a>` 
            : displayName}
        </div>
        <div class="session-card__meta">
          <span class="session-card__kind">${row.kind}</span>
          <span class="session-card__meta-divider"></span>
          <span>${timeAgo}</span>
        </div>
      </div>
      <div class="session-card__actions">
        <span class="session-card__badge session-card__badge--${status.status}">${status.label}</span>
      </div>
    </div>
  `;
}

function renderSessionDetail(row: GatewaySessionRow, props: SessionsProps) {
  const status = getSessionStatus(row.updatedAt);
  const displayName = row.displayName ?? row.label ?? row.key;
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinkLevels = resolveThinkLevelOptions(row.modelProvider);
  const rawThinking = row.thinkingLevel ?? "";
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const verbose = row.verboseLevel ?? "";
  const reasoning = row.reasoningLevel ?? "";
  const chatUrl = row.kind !== "global"
    ? `${pathForTab("chat", props.basePath)}?session=${encodeURIComponent(row.key)}`
    : null;

  return html`
    <div class="session-detail">
      <div class="session-detail__header">
        <div class="session-detail__header-info">
          <div class="session-detail__status">
            <span class="session-card__dot session-card__dot--${status.status}"></span>
            <span class="session-card__badge session-card__badge--${status.status}">${status.label}</span>
          </div>
          <h2 class="session-detail__title mono">${displayName}</h2>
          <div class="session-detail__meta">
            <span>Kind: <strong>${row.kind}</strong></span>
            ${row.updatedAt ? html`<span> · Updated ${formatAgo(row.updatedAt)}</span>` : nothing}
          </div>
        </div>
        <button class="btn-icon" @click=${() => props.onSelectSession(null)} title="Close">
          ${icons.x}
        </button>
      </div>

      <div class="session-detail__content">
        <!-- Quick Actions -->
        <div class="session-detail__actions">
          ${chatUrl ? html`
            <a href=${chatUrl} class="btn-control btn-control--primary" style="text-decoration: none;">
              ${icons.chat}
              <span>Open Chat</span>
            </a>
          ` : nothing}
          <button 
            class="btn-control btn-control--danger" 
            ?disabled=${props.loading}
            @click=${() => props.onDelete(row.key)}
          >
            ${icons.trash}
            <span>Delete</span>
          </button>
        </div>

        <div class="divider"></div>

        <!-- Session Info -->
        <div class="session-detail__section">
          <h3 class="session-detail__section-title">Session Info</h3>
          <div class="session-detail__grid">
            <div class="session-detail__field">
              <label>Key</label>
              <div class="mono" style="font-size: 12px; word-break: break-all;">${row.key}</div>
            </div>
            <div class="session-detail__field">
              <label>Tokens</label>
              <div>${formatSessionTokens(row)}</div>
            </div>
            ${row.modelProvider ? html`
              <div class="session-detail__field">
                <label>Model Provider</label>
                <div>${row.modelProvider}</div>
              </div>
            ` : nothing}
          </div>
        </div>

        <div class="divider"></div>

        <!-- Session Settings -->
        <div class="session-detail__section">
          <h3 class="session-detail__section-title">Settings</h3>
          <div class="session-detail__fields">
            <div class="session-detail__field-row">
              <label>Label</label>
              <input
                .value=${row.label ?? ""}
                ?disabled=${props.loading}
                placeholder="Optional label"
                @change=${(e: Event) => {
                  const value = (e.target as HTMLInputElement).value.trim();
                  props.onPatch(row.key, { label: value || null });
                }}
              />
            </div>
            <div class="session-detail__field-row">
              <label>Thinking Level</label>
              <select
                .value=${thinking}
                ?disabled=${props.loading}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  props.onPatch(row.key, {
                    thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
                  });
                }}
              >
                ${thinkLevels.map((level) =>
                  html`<option value=${level}>${level || "inherit"}</option>`,
                )}
              </select>
            </div>
            <div class="session-detail__field-row">
              <label>Verbose</label>
              <select
                .value=${verbose}
                ?disabled=${props.loading}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  props.onPatch(row.key, { verboseLevel: value || null });
                }}
              >
                ${VERBOSE_LEVELS.map(
                  (level) => html`<option value=${level.value}>${level.label}</option>`,
                )}
              </select>
            </div>
            <div class="session-detail__field-row">
              <label>Reasoning</label>
              <select
                .value=${reasoning}
                ?disabled=${props.loading}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  props.onPatch(row.key, { reasoningLevel: value || null });
                }}
              >
                ${REASONING_LEVELS.map((level) =>
                  html`<option value=${level}>${level || "inherit"}</option>`,
                )}
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

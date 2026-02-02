import { html, nothing } from "lit";

import type { LogEntry, LogLevel } from "../types";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export type LogsProps = {
  loading: boolean;
  error: string | null;
  file: string | null;
  entries: LogEntry[];
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onRefresh: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: (event: Event) => void;
};

// Icons
const icons = {
  search: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  download: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  play: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
};

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", { 
    hour12: false, 
    hour: "2-digit", 
    minute: "2-digit", 
    second: "2-digit" 
  });
}

function matchesFilter(entry: LogEntry, needle: string) {
  if (!needle) return true;
  const haystack = [entry.message, entry.subsystem, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function renderLogs(props: LogsProps) {
  const needle = props.filterText.trim().toLowerCase();
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const filtered = props.entries.filter((entry) => {
    if (entry.level && !props.levelFilters[entry.level]) return false;
    return matchesFilter(entry, needle);
  });
  const exportLabel = needle || levelFiltered ? "filtered" : "visible";
  const totalCount = props.entries.length;
  const filteredCount = filtered.length;
  const isFiltering = needle || levelFiltered;

  // Count by level for stats
  const levelCounts = LEVELS.reduce((acc, level) => {
    acc[level] = filtered.filter(e => e.level === level).length;
    return acc;
  }, {} as Record<LogLevel, number>);

  return html`
    <div class="logs-card">
      <!-- Header -->
      <div class="logs-header">
        <div class="logs-header__info">
          <div class="logs-header__title">
            <span>Logs</span>
            ${props.autoFollow ? html`
              <span class="logs-live-badge logs-live-badge--live">
                <span class="logs-live-dot"></span>
                Live
              </span>
            ` : html`
              <span class="logs-live-badge logs-live-badge--paused">Paused</span>
            `}
          </div>
          <div class="logs-header__sub">
            ${isFiltering 
              ? `Showing ${filteredCount.toLocaleString()} of ${totalCount.toLocaleString()} entries`
              : `${totalCount.toLocaleString()} entries`}
            ${props.file ? html` · <span class="mono">${props.file}</span>` : nothing}
          </div>
        </div>
        <div class="logs-header__actions">
          <button 
            class="btn-control ${props.autoFollow ? '' : 'btn-control--primary'}"
            @click=${() => props.onToggleAutoFollow(!props.autoFollow)}
            title="${props.autoFollow ? "Pause auto-follow" : "Resume auto-follow"}"
          >
            ${props.autoFollow ? icons.pause : icons.play}
            <span>${props.autoFollow ? "Pause" : "Resume"}</span>
          </button>
          <button 
            class="btn-control" 
            ?disabled=${props.loading} 
            @click=${props.onRefresh}
            title="Refresh logs"
          >
            ${icons.refresh}
          </button>
          <button
            class="btn-control"
            ?disabled=${filtered.length === 0}
            @click=${() => props.onExport(filtered.map((entry) => entry.raw), exportLabel)}
            title="Export logs"
          >
            ${icons.download}
          </button>
        </div>
      </div>

      <!-- Filters Toolbar -->
      <div class="logs-toolbar">
        <div class="logs-search">
          <span class="logs-search__icon">${icons.search}</span>
          <input
            type="text"
            class="logs-search__input"
            .value=${props.filterText}
            @input=${(e: Event) =>
              props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder="Search logs..."
          />
        </div>
        <div class="logs-level-group">
          ${LEVELS.map(
            (level) => html`
              <label class="logs-level-chip ${level} ${props.levelFilters[level] ? "active" : ""}">
                <input
                  type="checkbox"
                  .checked=${props.levelFilters[level]}
                  @change=${(e: Event) =>
                    props.onLevelToggle(level, (e.target as HTMLInputElement).checked)}
                />
                <span>${level}</span>
                ${levelCounts[level] > 0 ? html`<span class="logs-level-count">${levelCounts[level]}</span>` : nothing}
              </label>
            `,
          )}
        </div>
      </div>

      ${props.truncated
        ? html`<div class="logs-notice">⚠️ Log output truncated; showing latest chunk.</div>`
        : nothing}
      ${props.error
        ? html`<div class="logs-notice logs-notice--error">❌ ${props.error}</div>`
        : nothing}

      <!-- Log Stream -->
      <div class="log-stream ${props.autoFollow ? "log-stream--live" : ""}" @scroll=${props.onScroll}>
        ${filtered.length === 0
          ? html`
              <div class="logs-empty">
                <div class="logs-empty__icon">📋</div>
                <div class="logs-empty__text">${isFiltering ? "No logs match your filters" : "No log entries yet"}</div>
              </div>
            `
          : filtered.map(
              (entry) => html`
                <div class="log-row log-row--${entry.level ?? "info"}">
                  <div class="log-time">${formatTime(entry.time)}</div>
                  <div class="log-level log-level--${entry.level ?? "info"}">${entry.level ?? "—"}</div>
                  <div class="log-subsystem">${entry.subsystem ?? ""}</div>
                  <div class="log-message">${entry.message ?? entry.raw}</div>
                </div>
              `,
            )}
      </div>
    </div>
  `;
}

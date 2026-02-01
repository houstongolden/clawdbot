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

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
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

  return html`
    <section class="card logs-card">
      <!-- Header with streaming indicator -->
      <div class="logs-header">
        <div class="logs-header__info">
          <div class="card-title" style="display: flex; align-items: center; gap: 10px;">
            Logs
            ${props.autoFollow ? html`
              <span class="logs-live-indicator">
                <span class="logs-live-dot"></span>
                Live
              </span>
            ` : html`
              <span class="logs-paused-indicator">Paused</span>
            `}
          </div>
          <div class="card-sub">
            ${isFiltering 
              ? `Showing ${filteredCount} of ${totalCount} entries`
              : `${totalCount} entries`}
            ${props.file ? ` · ${props.file}` : ""}
          </div>
        </div>
        <div class="logs-header__actions">
          <button 
            class="btn btn-sm ${props.autoFollow ? "" : "btn-primary"}" 
            @click=${() => props.onToggleAutoFollow(!props.autoFollow)}
            title="${props.autoFollow ? "Pause auto-follow" : "Resume auto-follow"}"
          >
            ${props.autoFollow ? "⏸ Pause" : "▶ Resume"}
          </button>
          <button class="btn btn-sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "…" : "↻"}
          </button>
          <button
            class="btn btn-sm"
            ?disabled=${filtered.length === 0}
            @click=${() => props.onExport(filtered.map((entry) => entry.raw), exportLabel)}
            title="Export logs"
          >
            ↓ Export
          </button>
        </div>
      </div>

      <!-- Filters Row -->
      <div class="logs-filters">
        <div class="logs-search">
          <input
            type="text"
            class="logs-search__input"
            .value=${props.filterText}
            @input=${(e: Event) =>
              props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder="🔍 Search logs..."
          />
        </div>
        <div class="logs-level-filters">
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
              </label>
            `,
          )}
        </div>
      </div>

      ${props.truncated
        ? html`<div class="logs-notice">Log output truncated; showing latest chunk.</div>`
        : nothing}
      ${props.error
        ? html`<div class="logs-notice logs-notice--error">${props.error}</div>`
        : nothing}

      <!-- Log Stream -->
      <div class="log-stream ${props.autoFollow ? "log-stream--live" : ""}" @scroll=${props.onScroll}>
        ${filtered.length === 0
          ? html`<div class="logs-empty">
              <div class="logs-empty__icon">📋</div>
              <div class="logs-empty__text">No log entries${isFiltering ? " match your filters" : ""}</div>
            </div>`
          : filtered.map(
              (entry) => html`
                <div class="log-row log-row--${entry.level ?? "info"}">
                  <div class="log-time mono">${formatTime(entry.time)}</div>
                  <div class="log-level log-level--${entry.level ?? "info"}">${entry.level ?? ""}</div>
                  <div class="log-subsystem mono">${entry.subsystem ?? ""}</div>
                  <div class="log-message mono">${entry.message ?? entry.raw}</div>
                </div>
              `,
            )}
      </div>
    </section>
  `;
}

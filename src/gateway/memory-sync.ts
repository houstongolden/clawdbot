/**
 * Memory Sync (local -> myo.ai cloud)
 *
 * Syncs a small allowlisted set of Markdown memory files to myo.ai via
 * POST /api/gateway/sync/documents.
 *
 * Cloud is a read-only mirror. Local always wins.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-sync");

export type MemorySyncOptions = {
  /** Workspace root to scan. */
  workspaceDir: string;
  /** Cloud base URL, e.g. https://myo.ai (no trailing slash). */
  cloudApiUrl: string;
  /** Gateway auth token (Bearer) issued during pairing. */
  gatewayToken: string;
  /** Sync interval in ms. */
  everyMs: number;
};

type SyncState = {
  version: 1;
  files: Record<
    string,
    {
      hash: string;
      updatedAtMs: number;
    }
  >;
};

type SyncedDocument = {
  filePath: string;
  fileName: string;
  docType: "markdown" | "note" | "memory" | "config" | "other";
  content: string;
  title?: string;
  tags?: string[];
  fileModifiedAt?: string;
};

const DEFAULT_STATE_FILENAME = "myo-memory-sync-state.json";

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    if (override.startsWith("~")) {
      return path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveStatePath(): string {
  return path.join(resolveStateDir(), DEFAULT_STATE_FILENAME);
}

async function loadState(): Promise<SyncState> {
  try {
    const raw = await fs.readFile(resolveStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as SyncState;
    if (parsed?.version !== 1 || typeof parsed.files !== "object" || !parsed.files) {
      return { version: 1, files: {} };
    }
    return parsed;
  } catch {
    return { version: 1, files: {} };
  }
}

async function saveState(state: SyncState): Promise<void> {
  const outPath = resolveStatePath();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(state, null, 2), "utf-8");
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function safeReadTextFile(
  absPath: string,
): Promise<{ content: string; mtimeIso: string } | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(absPath, "utf-8");
    return { content, mtimeIso: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function listAgentDirs(workspaceDir: string): Promise<string[]> {
  const agentsDir = path.join(workspaceDir, "agents");
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(agentsDir, e.name));
  } catch {
    return [];
  }
}

async function listDailyNotes(workspaceDir: string): Promise<string[]> {
  const memDir = path.join(workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
      .map((e) => path.join(memDir, e.name));
  } catch {
    return [];
  }
}

function toWorkspaceRelativePath(workspaceDir: string, absPath: string): string {
  const rel = path.relative(workspaceDir, absPath);
  // Normalize to POSIX for storage/UI consistency.
  return rel.split(path.sep).join("/");
}

function classifyDocType(relPath: string): SyncedDocument["docType"] {
  const normalized = relPath.toLowerCase();
  if (normalized === "memory.md") return "memory";
  if (normalized.startsWith("memory/") && /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(normalized))
    return "note";
  if (normalized.endsWith("/soul.md")) return "config";
  if (normalized.endsWith("/memory/working.md")) return "memory";
  return "markdown";
}

function buildTags(relPath: string): string[] {
  // tags for UI filtering
  const tags: string[] = ["memory-sync"];
  const parts = relPath.split("/");
  const agentsIdx = parts.indexOf("agents");
  if (agentsIdx >= 0 && parts.length > agentsIdx + 1) {
    tags.push(`agent:${parts[agentsIdx + 1]}`);
  }
  if (relPath === "MEMORY.md") tags.push("root");
  if (relPath.startsWith("memory/")) tags.push("daily");
  if (relPath.startsWith("projects/")) tags.push("project-doc");
  return tags;
}

async function gatherAllowlistedFiles(workspaceDir: string): Promise<string[]> {
  const out: string[] = [];

  // workspace/MEMORY.md
  out.push(path.join(workspaceDir, "MEMORY.md"));

  // workspace/memory/YYYY-MM-DD.md
  out.push(...(await listDailyNotes(workspaceDir)));

  // workspace/agents/*/SOUL.md and workspace/agents/*/memory/WORKING.md
  for (const agentDir of await listAgentDirs(workspaceDir)) {
    out.push(path.join(agentDir, "SOUL.md"));
    out.push(path.join(agentDir, "memory", "WORKING.md"));
  }

  // allowlist: planning/project docs under workspace/projects (markdown only)
  // This keeps key architecture/todo docs visible in the web UI, without syncing secrets.
  try {
    const projectsDir = path.join(workspaceDir, "projects");
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const sub = path.join(projectsDir, ent.name);
      const docs = await fs.readdir(sub, { withFileTypes: true }).catch(() => []);
      for (const d of docs) {
        if (!d.isFile()) continue;
        if (!d.name.toLowerCase().endsWith(".md")) continue;
        out.push(path.join(sub, d.name));
      }
    }
  } catch {
    // ignore
  }

  // Deduplicate
  return Array.from(new Set(out));
}

async function postDocuments(params: {
  cloudApiUrl: string;
  gatewayToken: string;
  documents: SyncedDocument[];
}): Promise<{ ok: boolean; status: number; text?: string }> {
  const res = await fetch(`${params.cloudApiUrl.replace(/\/$/, "")}/api/gateway/sync/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.gatewayToken}`,
    },
    body: JSON.stringify({ documents: params.documents, fullSync: false }),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

export function startMemorySync(opts: MemorySyncOptions): { stop: () => void } {
  const resolved = {
    ...opts,
    cloudApiUrl: opts.cloudApiUrl.replace(/\/$/, ""),
  };

  if (!resolved.gatewayToken.trim()) {
    log.warn("memory sync disabled: missing gateway token");
    return { stop: () => {} };
  }

  if (!resolved.cloudApiUrl.trim()) {
    log.warn("memory sync disabled: missing cloudApiUrl");
    return { stop: () => {} };
  }

  if (!resolved.workspaceDir.trim()) {
    log.warn("memory sync disabled: missing workspaceDir");
    return { stop: () => {} };
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      const state = await loadState();
      const absPaths = await gatherAllowlistedFiles(resolved.workspaceDir);

      const docs: SyncedDocument[] = [];
      let considered = 0;
      let changed = 0;

      for (const absPath of absPaths) {
        const relPath = toWorkspaceRelativePath(resolved.workspaceDir, absPath);
        // Only sync markdown files.
        if (!relPath.toLowerCase().endsWith(".md")) continue;

        const read = await safeReadTextFile(absPath);
        if (!read) continue;

        considered++;
        const hash = sha256(read.content);
        const prev = state.files[relPath];
        if (prev?.hash === hash) continue;

        changed++;
        docs.push({
          filePath: relPath,
          fileName: path.basename(relPath),
          docType: classifyDocType(relPath),
          content: read.content,
          fileModifiedAt: read.mtimeIso,
          tags: buildTags(relPath),
        });
      }

      if (docs.length === 0) {
        log.debug(`no changes (considered=${considered})`);
        return;
      }

      const res = await postDocuments({
        cloudApiUrl: resolved.cloudApiUrl,
        gatewayToken: resolved.gatewayToken,
        documents: docs,
      });

      if (!res.ok) {
        log.warn(`sync failed: HTTP ${res.status}: ${res.text?.slice(0, 500) ?? ""}`);
        return;
      }

      // Mark successfully uploaded docs as synced.
      const now = Date.now();
      for (const doc of docs) {
        state.files[doc.filePath] = { hash: sha256(doc.content), updatedAtMs: now };
      }
      await saveState(state);

      log.info(`synced ${docs.length} files (considered=${considered}, changed=${changed})`);
    } catch (err) {
      log.warn(`sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  // Run once shortly after start, then on interval.
  const initialDelayMs = Math.min(15_000, Math.max(1_000, Math.floor(resolved.everyMs / 10)));
  const initialTimer = setTimeout(() => tick().catch(() => {}), initialDelayMs);

  timer = setInterval(() => tick().catch(() => {}), resolved.everyMs);
  timer.unref?.();

  return {
    stop: () => {
      clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Read the most recently used Myo gateway token from ~/.openclaw/myo-tokens.json.
 *
 * NOTE: This is the *local* gateway auth token that myo.ai stores in gateway_connections.auth_token.
 */
export async function readLatestGatewayTokenFromDisk(): Promise<string> {
  const stateDir = resolveStateDir();
  const tokensPath = path.join(stateDir, "myo-tokens.json");

  try {
    const raw = await fs.readFile(tokensPath, "utf-8");
    const list = JSON.parse(raw) as Array<{
      token?: string;
      lastUsedAt?: number;
      createdAt?: number;
    }>;
    const tokens = Array.isArray(list) ? list : [];
    const sorted = tokens
      .filter((t) => typeof t.token === "string" && t.token.trim())
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0));

    return sorted[0]?.token?.trim() ?? "";
  } catch {
    return "";
  }
}

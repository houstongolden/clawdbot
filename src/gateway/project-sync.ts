/**
 * Project Sync (Dropbox-style)
 *
 * Periodically sync metadata for selected project folders to myo.ai.
 *
 * - Only metadata (path/name/type/size/modified/isHidden)
 * - Uploads to POST /api/gateway/sync/files using gateway token auth
 * - Designed to keep web + local aligned without uploading full contents
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("project-sync");

export type ProjectSyncParams = {
  cloudApiUrl: string;
  gatewayToken: string;
  workspaceDir: string;
  everyMs?: number;
  projectPaths?: string[]; // relative to workspaceDir or absolute
  maxItems?: number;
};

type SyncedFile = {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modified: string;
  isHidden: boolean;
  mimeType?: string;
};

const DEFAULT_EVERY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ITEMS = 5000;

const EXCLUDE_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const EXCLUDE_FILE_PREFIXES = [".env"];

let timer: NodeJS.Timeout | null = null;

function isHiddenName(name: string) {
  return name.startsWith(".");
}

function shouldSkipName(name: string) {
  if (EXCLUDE_DIRS.has(name)) return true;
  for (const p of EXCLUDE_FILE_PREFIXES) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

async function walkDir(root: string, maxItems: number): Promise<SyncedFile[]> {
  const out: SyncedFile[] = [];

  async function walk(current: string) {
    if (out.length >= maxItems) return;

    let entries: any[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const ent of entries) {
      if (out.length >= maxItems) break;
      const name = ent.name as string;
      if (shouldSkipName(name)) continue;

      const full = path.join(current, name);
      const rel = path.relative(root, full);

      try {
        const st = await fs.lstat(full);
        const type: SyncedFile["type"] = st.isDirectory()
          ? "directory"
          : st.isSymbolicLink()
            ? "symlink"
            : "file";

        out.push({
          path: rel,
          name,
          type,
          size: type === "file" ? st.size : 0,
          modified: st.mtime.toISOString(),
          isHidden: isHiddenName(name),
        });

        if (st.isDirectory() && !EXCLUDE_DIRS.has(name)) {
          await walk(full);
        }
      } catch {
        continue;
      }
    }
  }

  await walk(root);
  return out;
}

async function pushFiles(params: ProjectSyncParams, rootAbs: string, files: SyncedFile[]) {
  const url = `${params.cloudApiUrl.replace(/\/$/, "")}/api/gateway/sync/files`;

  const body = {
    files: files.map((f) => ({
      ...f,
      // prefix with root folder name to avoid collisions across projects
      path: `${path.basename(rootAbs)}/${f.path}`.replace(/\\/g, "/"),
    })),
    rootPath: rootAbs,
    fullSync: true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.gatewayToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sync/files failed: ${res.status} ${text}`);
  }
}

export function startProjectSync(params: ProjectSyncParams) {
  stopProjectSync();

  const everyMs = params.everyMs ?? DEFAULT_EVERY_MS;
  const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;

  const pathsEnv = process.env.MYO_PROJECT_SYNC_PATHS;
  const configured =
    params.projectPaths && params.projectPaths.length > 0
      ? params.projectPaths
      : pathsEnv
        ? pathsEnv
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

  if (!configured.length) {
    log.debug("No project paths configured; skipping project sync.");
    return { started: false };
  }

  const roots = configured
    .map((p) => (path.isAbsolute(p) ? p : path.join(params.workspaceDir, p)))
    .filter((p) => existsSync(p));

  if (!roots.length) {
    log.warn("Project sync paths configured but none exist.");
    return { started: false };
  }

  const tick = async () => {
    for (const rootAbs of roots) {
      try {
        log.info(`Syncing project metadata: ${rootAbs}`);
        const files = await walkDir(rootAbs, maxItems);
        await pushFiles(params, rootAbs, files);
        log.info(`Project metadata synced: ${rootAbs} (${files.length} items)`);
      } catch (e: any) {
        log.warn(`Project sync failed for ${rootAbs}: ${e?.message || e}`);
      }
    }
  };

  // run once shortly after start
  void tick();
  timer = setInterval(() => void tick(), everyMs);
  log.info(`Project sync started (every ${Math.round(everyMs / 1000)}s).`);
  return { started: true, roots };
}

export function stopProjectSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("Project sync stopped.");
  }
}

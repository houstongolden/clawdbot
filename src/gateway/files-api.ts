/**
 * Files API for Myo.ai File Browser Bridge
 *
 * Enables secure file browsing and access from Myo.ai cloud interface.
 * All operations are restricted to the workspace directory.
 *
 * Endpoints:
 * - GET /api/files?path= - List directory contents
 * - GET /api/files/read?path= - Read file content (with size limits)
 * - POST /api/files/upload - Upload file to workspace
 * - DELETE /api/files?path= - Delete file/directory
 *
 * Security:
 * - Path traversal prevention
 * - Workspace-only access
 * - File size limits (10MB read, 50MB upload)
 * - Rate limiting
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import { loadConfig } from "../config/config.js";

// ============================================================================
// Types
// ============================================================================

interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modified: string;
  created: string;
  extension?: string;
  mimeType?: string;
  isHidden: boolean;
}

interface DirectoryListing {
  path: string;
  files: FileInfo[];
  parent: string | null;
  totalSize: number;
  itemCount: number;
}

interface FileContent {
  path: string;
  content: string;
  size: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  truncated: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_DIRECTORY_ITEMS = 1000;

// Rate limiting
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // requests per window

// MIME type mapping
const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".jsx": "text/jsx",
  ".tsx": "text/tsx",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".less": "text/x-less",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".sh": "application/x-sh",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".sql": "application/sql",
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".dockerignore": "text/plain",
  ".editorconfig": "text/plain",
};

// Text file extensions (safe to read as UTF-8)
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".yaml",
  ".yml",
  ".xml",
  ".svg",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".csv",
  ".vue",
  ".svelte",
  ".astro",
]);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get workspace directory from config
 */
function getWorkspaceDir(): string {
  const config = loadConfig();
  // Use workspace from agent defaults, or fall back to current directory
  return config.agents?.defaults?.workspace || process.cwd();
}

/**
 * Validate and resolve path within workspace
 * Returns null if path is outside workspace or invalid
 */
function resolveSafePath(requestPath: string): string | null {
  const workspace = getWorkspaceDir();

  // Decode URI components
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  // Normalize and resolve
  const normalizedPath = path.normalize(decodedPath);

  // Reject obvious traversal attempts
  if (normalizedPath.includes("..") || normalizedPath.includes("\0")) {
    return null;
  }

  // Resolve full path
  const fullPath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(workspace, normalizedPath);

  // Ensure path is within workspace
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedPath = path.resolve(fullPath);

  if (!resolvedPath.startsWith(resolvedWorkspace)) {
    return null;
  }

  return resolvedPath;
}

/**
 * Get MIME type for file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Check if file is a text file
 */
function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === "";
}

/**
 * Rate limit check
 */
function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(clientId);

  if (!record || now > record.resetAt) {
    requestCounts.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }

  record.count++;
  return true;
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Get file info
 */
async function getFileInfo(filePath: string, basePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  let type: "file" | "directory" | "symlink" = "file";
  if (stats.isDirectory()) type = "directory";
  else if (stats.isSymbolicLink()) type = "symlink";

  return {
    name,
    path: path.relative(basePath, filePath) || ".",
    type,
    size: stats.size,
    modified: stats.mtime.toISOString(),
    created: stats.birthtime.toISOString(),
    extension: type === "file" ? ext : undefined,
    mimeType: type === "file" ? getMimeType(filePath) : undefined,
    isHidden: name.startsWith("."),
  };
}

// ============================================================================
// API Handlers
// ============================================================================

/**
 * List directory contents
 */
async function handleListDirectory(
  requestPath: string,
  showHidden: boolean = false,
): Promise<DirectoryListing | { error: string; status: number }> {
  const workspace = getWorkspaceDir();
  const safePath = resolveSafePath(requestPath || ".");

  if (!safePath) {
    return { error: "Invalid path or access denied", status: 403 };
  }

  // Check if path exists
  try {
    const stats = await fs.stat(safePath);
    if (!stats.isDirectory()) {
      return { error: "Path is not a directory", status: 400 };
    }
  } catch {
    return { error: "Directory not found", status: 404 };
  }

  // Read directory
  const entries = await fs.readdir(safePath, { withFileTypes: true });
  const files: FileInfo[] = [];
  let totalSize = 0;

  for (const entry of entries.slice(0, MAX_DIRECTORY_ITEMS)) {
    // Skip hidden files unless requested
    if (!showHidden && entry.name.startsWith(".")) continue;

    try {
      const entryPath = path.join(safePath, entry.name);
      const info = await getFileInfo(entryPath, workspace);
      files.push(info);
      totalSize += info.size;
    } catch {
      // Skip files we can't access
      continue;
    }
  }

  // Sort: directories first, then alphabetically
  files.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  // Calculate parent path
  const relativePath = path.relative(workspace, safePath);
  const parentPath = relativePath ? path.dirname(relativePath) : null;

  return {
    path: relativePath || ".",
    files,
    parent: parentPath === "." ? null : parentPath,
    totalSize,
    itemCount: files.length,
  };
}

/**
 * Read file content
 */
async function handleReadFile(
  requestPath: string,
  maxSize: number = MAX_READ_SIZE,
): Promise<FileContent | { error: string; status: number }> {
  const workspace = getWorkspaceDir();
  const safePath = resolveSafePath(requestPath);

  if (!safePath) {
    return { error: "Invalid path or access denied", status: 403 };
  }

  // Check if file exists
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(safePath);
    if (!stats.isFile()) {
      return { error: "Path is not a file", status: 400 };
    }
  } catch {
    return { error: "File not found", status: 404 };
  }

  // Check size
  if (stats.size > maxSize) {
    return { error: `File too large (max ${maxSize / 1024 / 1024}MB)`, status: 413 };
  }

  const mimeType = getMimeType(safePath);
  const isText = isTextFile(safePath);

  let content: string;
  let encoding: "utf8" | "base64";
  let truncated = false;

  if (isText) {
    // Read as text
    const buffer = await fs.readFile(safePath);
    content = buffer.toString("utf8");
    encoding = "utf8";

    // Truncate very long text files for preview
    if (content.length > 500000) {
      content = content.slice(0, 500000);
      truncated = true;
    }
  } else {
    // Read as base64 for binary files
    const buffer = await fs.readFile(safePath);
    content = buffer.toString("base64");
    encoding = "base64";
  }

  return {
    path: path.relative(workspace, safePath),
    content,
    size: stats.size,
    mimeType,
    encoding,
    truncated,
  };
}

/**
 * Upload file
 */
async function handleUploadFile(
  requestPath: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
): Promise<{ path: string; size: number } | { error: string; status: number }> {
  const workspace = getWorkspaceDir();
  const safePath = resolveSafePath(requestPath);

  if (!safePath) {
    return { error: "Invalid path or access denied", status: 403 };
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(safePath);
  try {
    await fs.mkdir(parentDir, { recursive: true });
  } catch {
    return { error: "Cannot create parent directory", status: 500 };
  }

  // Decode and write content
  let buffer: Buffer;
  if (encoding === "base64") {
    buffer = Buffer.from(content, "base64");
  } else {
    buffer = Buffer.from(content, "utf8");
  }

  if (buffer.length > MAX_UPLOAD_SIZE) {
    return { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)`, status: 413 };
  }

  try {
    await fs.writeFile(safePath, buffer);
  } catch (err) {
    return {
      error: `Write failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      status: 500,
    };
  }

  return {
    path: path.relative(workspace, safePath),
    size: buffer.length,
  };
}

/**
 * Delete file or directory
 */
async function handleDeleteFile(
  requestPath: string,
): Promise<{ deleted: string } | { error: string; status: number }> {
  const workspace = getWorkspaceDir();
  const safePath = resolveSafePath(requestPath);

  if (!safePath) {
    return { error: "Invalid path or access denied", status: 403 };
  }

  // Don't allow deleting workspace root
  if (safePath === path.resolve(workspace)) {
    return { error: "Cannot delete workspace root", status: 403 };
  }

  try {
    const stats = await fs.stat(safePath);
    if (stats.isDirectory()) {
      await fs.rm(safePath, { recursive: true });
    } else {
      await fs.unlink(safePath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: "File not found", status: 404 };
    }
    return {
      error: `Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      status: 500,
    };
  }

  return { deleted: path.relative(workspace, safePath) };
}

// ============================================================================
// HTTP Handler
// ============================================================================

/**
 * HTTP handler for files API
 */
export async function handleFilesRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle /api/files routes
  if (!url.pathname.startsWith("/api/files")) {
    return false;
  }

  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Rate limiting
  const clientId =
    req.headers["x-forwarded-for"]?.toString() || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(clientId)) {
    sendJson(res, 429, { error: "Rate limit exceeded. Try again later." });
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/files?path= - List directory
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/files") {
    const requestPath = url.searchParams.get("path") || ".";
    const showHidden = url.searchParams.get("hidden") === "true";

    const result = await handleListDirectory(requestPath, showHidden);

    if ("error" in result) {
      sendJson(res, result.status, { error: result.error });
    } else {
      sendJson(res, 200, result);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/files/read?path= - Read file content
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/files/read") {
    const requestPath = url.searchParams.get("path");

    if (!requestPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return true;
    }

    const result = await handleReadFile(requestPath);

    if ("error" in result) {
      sendJson(res, result.status, { error: result.error });
    } else {
      sendJson(res, 200, result);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/files/download?path= - Download file
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/files/download") {
    const requestPath = url.searchParams.get("path");

    if (!requestPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return true;
    }

    const safePath = resolveSafePath(requestPath);
    if (!safePath) {
      sendJson(res, 403, { error: "Invalid path or access denied" });
      return true;
    }

    try {
      const stats = statSync(safePath);
      if (!stats.isFile()) {
        sendJson(res, 400, { error: "Path is not a file" });
        return true;
      }

      const fileName = path.basename(safePath);
      const mimeType = getMimeType(safePath);

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

      const stream = createReadStream(safePath);
      stream.pipe(res);
      stream.on("error", () => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Read error" });
        }
      });
    } catch {
      sendJson(res, 404, { error: "File not found" });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /api/files/upload - Upload file
  // -------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/files/upload") {
    let body = "";
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);

    if (contentLength > MAX_UPLOAD_SIZE) {
      sendJson(res, 413, { error: `Request too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` });
      return true;
    }

    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_UPLOAD_SIZE) {
        sendJson(res, 413, { error: `Request too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` });
        return true;
      }
    }

    let data: { path: string; content: string; encoding?: "utf8" | "base64" };
    try {
      data = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }

    if (!data.path || !data.content) {
      sendJson(res, 400, { error: "Missing path or content" });
      return true;
    }

    const result = await handleUploadFile(data.path, data.content, data.encoding);

    if ("error" in result) {
      sendJson(res, result.status, { error: result.error });
    } else {
      sendJson(res, 201, { success: true, ...result });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // DELETE /api/files?path= - Delete file/directory
  // -------------------------------------------------------------------------
  if (req.method === "DELETE" && url.pathname === "/api/files") {
    const requestPath = url.searchParams.get("path");

    if (!requestPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return true;
    }

    const result = await handleDeleteFile(requestPath);

    if ("error" in result) {
      sendJson(res, result.status, { error: result.error });
    } else {
      sendJson(res, 200, { success: true, ...result });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/files/info?path= - Get file/directory info
  // -------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/files/info") {
    const requestPath = url.searchParams.get("path");

    if (!requestPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return true;
    }

    const workspace = getWorkspaceDir();
    const safePath = resolveSafePath(requestPath);

    if (!safePath) {
      sendJson(res, 403, { error: "Invalid path or access denied" });
      return true;
    }

    try {
      const info = await getFileInfo(safePath, workspace);
      sendJson(res, 200, info);
    } catch {
      sendJson(res, 404, { error: "Path not found" });
    }
    return true;
  }

  // Route not found
  sendJson(res, 404, { error: "Not found" });
  return true;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  handleFilesRequest,
  resolveSafePath,
  getWorkspaceDir,
};

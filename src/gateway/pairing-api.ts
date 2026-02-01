/**
 * Pairing API for Myo.ai Integration
 *
 * Handles pairing code exchange between Myo.ai cloud and local Myobot gateway.
 *
 * Flow:
 * 1. User adds gateway in Myo.ai with gateway URL
 * 2. Myo.ai generates pairing code and shows to user
 * 3. User enters code in Myobot Control UI (or Myo.ai sends it via /api/pair)
 * 4. Myobot validates code and returns auth token
 * 5. Myo.ai stores token for future connections
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

// In-memory store for pending pairing requests (in production, use Redis or similar)
interface PendingPairing {
  code: string;
  createdAt: number;
  expiresAt: number;
  clientInfo?: {
    origin?: string;
    userAgent?: string;
  };
}

const pendingPairings = new Map<string, PendingPairing>();
const PAIRING_CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Approved tokens - persisted to disk
interface ApprovedToken {
  token: string;
  createdAt: number;
  lastUsedAt: number;
  clientInfo?: {
    origin?: string;
    name?: string;
  };
}

const approvedTokens = new Map<string, ApprovedToken>();

// ============================================================================
// Token Persistence (B06 Fix)
// ============================================================================

const MYO_TOKENS_FILENAME = "myo-tokens.json";

/**
 * Resolve the OpenClaw state directory
 */
function resolveOpenClawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    if (override.startsWith("~")) {
      return path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(override);
  }
  // Check for existing directories
  const newDir = path.join(os.homedir(), ".openclaw");
  const legacyDirs = [".clawdbot", ".moltbot", ".moldbot"].map((d) => path.join(os.homedir(), d));

  if (fs.existsSync(newDir)) return newDir;
  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  if (existingLegacy) return existingLegacy;
  return newDir;
}

/**
 * Get the path to the tokens file
 */
function getTokensFilePath(): string {
  return path.join(resolveOpenClawStateDir(), MYO_TOKENS_FILENAME);
}

/**
 * Load tokens from disk
 */
function loadTokensFromDisk(): void {
  try {
    const filePath = getTokensFilePath();
    if (!fs.existsSync(filePath)) {
      console.log("[pairing-api] No persisted tokens file found");
      return;
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const tokens = JSON.parse(data) as ApprovedToken[];

    approvedTokens.clear();
    for (const token of tokens) {
      if (token.token && typeof token.token === "string") {
        approvedTokens.set(token.token, token);
      }
    }

    console.log(`[pairing-api] Loaded ${approvedTokens.size} tokens from disk`);
  } catch (err) {
    console.error("[pairing-api] Failed to load tokens from disk:", err);
  }
}

/**
 * Save tokens to disk
 */
function saveTokensToDisk(): void {
  try {
    const filePath = getTokensFilePath();
    const dirPath = path.dirname(filePath);

    // Ensure directory exists
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    const tokens = Array.from(approvedTokens.values());
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf-8");

    console.log(`[pairing-api] Saved ${tokens.length} tokens to disk`);
  } catch (err) {
    console.error("[pairing-api] Failed to save tokens to disk:", err);
  }
}

// Load tokens on module initialization
loadTokensFromDisk();

/**
 * Generate a cryptographically secure pairing code
 */
export function generatePairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No ambiguous chars (0/O, 1/I/L)
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/**
 * Generate a secure auth token
 */
export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new pairing request
 */
export function createPairingRequest(clientInfo?: PendingPairing["clientInfo"]): {
  code: string;
  expiresAt: number;
} {
  const code = generatePairingCode();
  const now = Date.now();
  const expiresAt = now + PAIRING_CODE_EXPIRY_MS;

  pendingPairings.set(code, {
    code,
    createdAt: now,
    expiresAt,
    clientInfo,
  });

  // Clean up expired pairings
  cleanupExpiredPairings();

  return { code, expiresAt };
}

/**
 * Validate and exchange a pairing code for an auth token
 */
export function exchangePairingCode(
  code: string,
  clientInfo?: ApprovedToken["clientInfo"],
): { success: boolean; token?: string; error?: string } {
  const normalizedCode = code.toUpperCase().replace(/[^A-Z2-9]/g, "");

  const pending = pendingPairings.get(normalizedCode);
  if (!pending) {
    return { success: false, error: "Invalid pairing code" };
  }

  if (Date.now() > pending.expiresAt) {
    pendingPairings.delete(normalizedCode);
    return { success: false, error: "Pairing code expired" };
  }

  // Code is valid - generate token
  const token = generateAuthToken();
  const now = Date.now();

  approvedTokens.set(token, {
    token,
    createdAt: now,
    lastUsedAt: now,
    clientInfo,
  });

  // Remove the used pairing code
  pendingPairings.delete(normalizedCode);

  // Persist tokens to disk (B06 fix)
  saveTokensToDisk();

  return { success: true, token };
}

/**
 * Validate an auth token
 */
export function validateToken(token: string): boolean {
  const approved = approvedTokens.get(token);
  if (!approved) return false;

  // Update last used time
  approved.lastUsedAt = Date.now();
  return true;
}

/**
 * Reload tokens from disk (for testing/recovery)
 */
export function reloadTokensFromDisk(): void {
  loadTokensFromDisk();
}

/**
 * Get token count (for diagnostics)
 */
export function getApprovedTokenCount(): number {
  return approvedTokens.size;
}

/**
 * Revoke an auth token
 */
export function revokeToken(token: string): boolean {
  const deleted = approvedTokens.delete(token);
  if (deleted) {
    // Persist tokens to disk (B06 fix)
    saveTokensToDisk();
  }
  return deleted;
}

/**
 * List all approved tokens (for admin UI)
 */
export function listApprovedTokens(): Array<{
  tokenPrefix: string;
  createdAt: number;
  lastUsedAt: number;
  clientInfo?: ApprovedToken["clientInfo"];
}> {
  return Array.from(approvedTokens.values()).map((t) => ({
    tokenPrefix: t.token.slice(0, 8) + "...",
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    clientInfo: t.clientInfo,
  }));
}

/**
 * Clean up expired pairing requests
 */
function cleanupExpiredPairings(): void {
  const now = Date.now();
  for (const [code, pairing] of pendingPairings) {
    if (now > pairing.expiresAt) {
      pendingPairings.delete(code);
    }
  }
}

/**
 * HTTP handler for pairing API
 */
export async function handlePairingRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle /api/pair routes
  if (!url.pathname.startsWith("/api/pair")) {
    return false;
  }

  // Set CORS headers for Myo.ai
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /api/pair - Generate new pairing code
  if (req.method === "GET" && url.pathname === "/api/pair") {
    const { code, expiresAt } = createPairingRequest({
      origin: req.headers.origin,
      userAgent: req.headers["user-agent"],
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        code,
        expiresAt,
        expiresIn: Math.round((expiresAt - Date.now()) / 1000),
      }),
    );
    return true;
  }

  // POST /api/pair - Exchange code for token
  if (req.method === "POST" && url.pathname === "/api/pair") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let data: { code?: string; name?: string };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    if (!data.code) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing pairing code" }));
      return true;
    }

    const result = exchangePairingCode(data.code, {
      origin: req.headers.origin,
      name: data.name,
    });

    if (result.success) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: result.token }));
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
    }
    return true;
  }

  // GET /api/pair/tokens - List approved tokens (requires gateway auth)
  if (req.method === "GET" && url.pathname === "/api/pair/tokens") {
    // TODO: Require gateway auth token
    const tokens = listApprovedTokens();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tokens }));
    return true;
  }

  // DELETE /api/pair/tokens/:token - Revoke a token
  if (req.method === "DELETE" && url.pathname.startsWith("/api/pair/tokens/")) {
    const tokenToRevoke = url.pathname.split("/").pop();
    if (tokenToRevoke && revokeToken(tokenToRevoke)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token not found" }));
    }
    return true;
  }

  return false;
}

export default {
  generatePairingCode,
  generateAuthToken,
  createPairingRequest,
  exchangePairingCode,
  validateToken,
  revokeToken,
  reloadTokensFromDisk,
  getApprovedTokenCount,
  listApprovedTokens,
  handlePairingRequest,
};

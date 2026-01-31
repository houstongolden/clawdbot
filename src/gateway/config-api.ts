/**
 * Config API for Myo.ai Integration
 *
 * Allows Myo.ai to read and manage Myobot configuration.
 *
 * Endpoints:
 * - GET /api/config - Get current configuration
 * - PATCH /api/config - Update configuration
 * - GET /api/config/skills - List installed skills
 * - GET /api/config/models - List available models
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";

/**
 * Validate auth token from request
 */
function validateAuth(req: IncomingMessage): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;
  // TODO: Validate against approved tokens from pairing
  return true;
}

/**
 * Get safe config (strip sensitive values)
 */
function getSafeConfig(): Record<string, unknown> {
  const config = loadConfig();

  // Strip sensitive values
  const safeConfig: Record<string, unknown> = {
    meta: config.meta,
    ui: config.ui,
    agents: {
      defaults: {
        workspace: config.agents?.defaults?.workspace,
        model: config.agents?.defaults?.model,
      },
      list: config.agents?.list?.map((agent) => ({
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace,
        model: agent.model,
      })),
    },
    gateway: {
      port: config.gateway?.port,
      mode: config.gateway?.mode,
      bind: config.gateway?.bind,
    },
    tools: {
      exec: config.tools?.exec,
      // Don't expose elevated tool config
    },
  };

  return safeConfig;
}

/**
 * List installed skills
 */
function listSkills(): Array<{
  name: string;
  path: string;
  hasSkillMd: boolean;
}> {
  const config = loadConfig();
  const workspace = config.agents?.defaults?.workspace || process.cwd();
  const skillsDir = path.join(workspace, "skills");

  const skills: Array<{ name: string; path: string; hasSkillMd: boolean }> = [];

  try {
    if (fs.existsSync(skillsDir)) {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(skillsDir, entry.name);
          const hasSkillMd = fs.existsSync(path.join(skillPath, "SKILL.md"));
          skills.push({
            name: entry.name,
            path: skillPath,
            hasSkillMd,
          });
        }
      }
    }
  } catch (err) {
    console.error("[config-api] Error listing skills:", err);
  }

  // Also check global skills
  const globalSkillsDir = path.join(process.env.HOME || "", ".openclaw", "skills");
  try {
    if (fs.existsSync(globalSkillsDir)) {
      const entries = fs.readdirSync(globalSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(globalSkillsDir, entry.name);
          const hasSkillMd = fs.existsSync(path.join(skillPath, "SKILL.md"));
          // Avoid duplicates
          if (!skills.some((s) => s.name === entry.name)) {
            skills.push({
              name: entry.name,
              path: skillPath,
              hasSkillMd,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[config-api] Error listing global skills:", err);
  }

  return skills;
}

/**
 * List available models
 */
function listModels(): Array<{
  provider: string;
  model: string;
  displayName: string;
}> {
  // Common models - in production, this would be dynamic
  return [
    { provider: "anthropic", model: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
    { provider: "anthropic", model: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
    { provider: "anthropic", model: "claude-haiku-3-5", displayName: "Claude Haiku 3.5" },
    { provider: "openai", model: "gpt-4o", displayName: "GPT-4o" },
    { provider: "openai", model: "gpt-4o-mini", displayName: "GPT-4o Mini" },
    { provider: "openai", model: "o1", displayName: "o1" },
    { provider: "openai", model: "o3-mini", displayName: "o3-mini" },
  ];
}

/**
 * HTTP handler for config API
 */
export async function handleConfigApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle /api/config routes
  if (!url.pathname.startsWith("/api/config")) {
    return false;
  }

  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Require auth for all config endpoints
  if (!validateAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  // GET /api/config - Get current configuration
  if (req.method === "GET" && url.pathname === "/api/config") {
    const config = getSafeConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ config }));
    return true;
  }

  // GET /api/config/skills - List installed skills
  if (req.method === "GET" && url.pathname === "/api/config/skills") {
    const skills = listSkills();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills }));
    return true;
  }

  // GET /api/config/models - List available models
  if (req.method === "GET" && url.pathname === "/api/config/models") {
    const models = listModels();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models }));
    return true;
  }

  // PATCH /api/config - Update configuration (limited)
  if (req.method === "PATCH" && url.pathname === "/api/config") {
    // For safety, only allow certain config updates via API
    // Full config changes should go through the gateway CLI
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Config updates via API not yet implemented",
        hint: "Use 'myo config' CLI for now",
      }),
    );
    return true;
  }

  return false;
}

export default {
  handleConfigApiRequest,
  getSafeConfig,
  listSkills,
  listModels,
};

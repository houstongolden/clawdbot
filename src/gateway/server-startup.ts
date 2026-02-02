import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startGmailWatcher } from "../hooks/gmail-watcher.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startRelayClient, stopRelayClient, isRelayEnabled } from "./relay-client.js";
import { startMemorySync } from "./memory-sync.js";
import { startProjectSync } from "./project-sync.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void; info?: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
  logRelay?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}) {
  // Start OpenClaw browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  if (!isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
    try {
      const gmailResult = await startGmailWatcher(params.cfg);
      if (gmailResult.started) {
        params.logHooks.info("gmail watcher started");
      } else if (
        gmailResult.reason &&
        gmailResult.reason !== "hooks not enabled" &&
        gmailResult.reason !== "no gmail account configured"
      ) {
        params.logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
      }
    } catch (err) {
      params.logHooks.error(`gmail watcher failed to start: ${String(err)}`);
    }
  }

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via OPENCLAW_SKIP_CHANNELS (or legacy OPENCLAW_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  // Start Myo.ai relay client if configured (gateway.relay.enabled)
  // This enables cloud access to local gateway features (files, sessions, etc.)
  let relayConnected = false;

  // Helper: load latest Myo gateway token (issued during pairing) from disk
  async function loadLatestMyoGatewayToken(): Promise<string | null> {
    const override = process.env.MYO_GATEWAY_TOKEN?.trim();
    if (override) return override;

    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
      ? process.env.OPENCLAW_STATE_DIR!.trim().replace(/^~(?=$|[\\/])/, os.homedir())
      : path.join(os.homedir(), ".openclaw");

    const tokenPath = path.join(stateDir, "myo-tokens.json");
    try {
      const raw = await fs.readFile(tokenPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const last = parsed[parsed.length - 1];
      if (typeof last?.token === "string" && last.token.trim()) return last.token.trim();
      return null;
    } catch {
      return null;
    }
  }
  const skipRelay = isTruthyEnvValue(process.env.OPENCLAW_SKIP_RELAY);
  if (!skipRelay && isRelayEnabled()) {
    try {
      const relayResult = await startRelayClient();
      if (relayResult.started) {
        relayConnected = true;
        const logInfo = params.logRelay?.info || params.log.info;
        logInfo?.(`myo.ai relay connected (gateway: ${relayResult.gatewayId})`);

        // Start background sync loops (Dropbox-style) once relay is up.
        // These loops are safe/allowlisted and require a valid MYO gateway token.
        const gatewayToken = (await loadLatestMyoGatewayToken()) || "";
        const cloudApiUrl = process.env.MYO_CLOUD_API_URL || "https://myo.ai";
        const everyMs = parseInt(process.env.MYO_MEMORY_SYNC_EVERY_MS || "300000", 10);

        if (gatewayToken) {
          try {
            startMemorySync({
              workspaceDir: params.defaultWorkspaceDir,
              cloudApiUrl,
              gatewayToken,
              everyMs: Number.isFinite(everyMs) ? everyMs : 300000,
            });
            logInfo?.("memory sync started");
          } catch (e) {
            const logWarn = params.logRelay?.warn || params.log.warn;
            logWarn(`memory sync failed to start: ${String(e)}`);
          }

          try {
            startProjectSync({
              workspaceDir: params.defaultWorkspaceDir,
              cloudApiUrl,
              gatewayToken,
              everyMs: Number.isFinite(everyMs) ? everyMs : 300000,
            });
            logInfo?.("project sync started");
          } catch (e) {
            const logWarn = params.logRelay?.warn || params.log.warn;
            logWarn(`project sync failed to start: ${String(e)}`);
          }
        } else {
          const logWarn = params.logRelay?.warn || params.log.warn;
          logWarn("sync loops not started: missing MYO gateway token (pairing token)");
        }
      } else if (relayResult.error) {
        const logWarn = params.logRelay?.warn || params.log.warn;
        logWarn(`myo.ai relay not started: ${relayResult.error}`);
      }
    } catch (err) {
      const logError = params.logRelay?.error || params.log.warn;
      logError(`myo.ai relay failed to start: ${String(err)}`);
    }
  }

  return { browserControl, pluginServices, relayConnected };
}

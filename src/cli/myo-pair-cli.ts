/**
 * Myo.ai Gateway Pairing CLI
 *
 * Usage: myo pair <code>
 *
 * Connects this local Myobot gateway to a Myo.ai cloud account.
 */

import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

const MYO_AI_URL = process.env.MYO_AI_URL || "https://myo.ai";

interface PairResult {
  success: boolean;
  connectionId?: string;
  authToken?: string;
  message?: string;
  error?: string;
}

async function completePairing(code: string): Promise<PairResult> {
  const cfg = loadConfig();

  // Get local gateway URL - handle different bind config formats
  const bind = cfg.gateway?.bind;
  let host = "127.0.0.1";
  let port = 18788;

  if (typeof bind === "object" && bind !== null && "host" in bind) {
    host = (bind as { host?: string }).host || host;
  }
  if (typeof bind === "object" && bind !== null && "port" in bind) {
    port = (bind as { port?: number }).port || port;
  }

  const gatewayUrl = `ws://${host}:${port}`;
  const controlUiUrl = `http://${host}:18789`;

  // Get machine name for gateway name
  const os = await import("node:os");
  const machineName = os.hostname() || "My Gateway";

  try {
    const response = await fetch(`${MYO_AI_URL}/api/pair/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: code.toUpperCase().trim(),
        gatewayUrl,
        controlUiUrl,
        name: machineName,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `Failed with status ${response.status}`,
      };
    }

    return {
      success: true,
      connectionId: data.connectionId,
      authToken: data.authToken,
      message: data.message,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

export function registerMyoPairCli(program: Command) {
  program
    .command("pair")
    .description("Connect this gateway to your Myo.ai account")
    .argument("<code>", "Pairing code from Myo.ai dashboard")
    .option("--url <url>", "Myo.ai URL (default: https://myo.ai)")
    .action(async (code: string, opts: { url?: string }) => {
      if (opts.url) {
        // Override MYO_AI_URL for testing
        process.env.MYO_AI_URL = opts.url;
      }

      defaultRuntime.log(theme.muted("Connecting to Myo.ai..."));

      const result = await completePairing(code);

      if (result.success) {
        defaultRuntime.log("");
        defaultRuntime.log(theme.success("✓ Gateway connected to Myo.ai!"));
        defaultRuntime.log("");
        defaultRuntime.log(theme.muted("You can now:"));
        defaultRuntime.log(`  • View sessions at ${theme.accent("myo.ai/gateway-sessions")}`);
        defaultRuntime.log(`  • Browse files at ${theme.accent("myo.ai/gateway-files")}`);
        defaultRuntime.log(`  • Manage tasks at ${theme.accent("myo.ai/tasks/kanban")}`);
        defaultRuntime.log("");

        // TODO: Store the auth token in config for authenticated requests
        // This would allow Myo.ai to make authenticated calls to this gateway
      } else {
        defaultRuntime.log("");
        defaultRuntime.log(theme.error(`✗ Pairing failed: ${result.error}`));
        defaultRuntime.log("");
        defaultRuntime.log(theme.muted("Make sure:"));
        defaultRuntime.log("  • The code is correct and hasn't expired");
        defaultRuntime.log("  • You're logged into myo.ai");
        defaultRuntime.log("  • Your internet connection is working");
        defaultRuntime.log("");
        process.exit(1);
      }
    });
}

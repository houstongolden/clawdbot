import { normalizeProfileName } from "./profile-utils.js";
import { replaceCliName, resolveCliName } from "./cli-name.js";

const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const cliName = resolveCliName();
  const normalizedCommand = replaceCliName(command, cliName);

  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (!profile) return normalizedCommand;

  const cliNamesForPrefix = [cliName, "openclaw"].filter(Boolean);
  const prefixAlternation = cliNamesForPrefix.map(escapeRegExp).join("|");
  const cliPrefixRe = new RegExp(
    `^(?:(?:pnpm|npm|bunx|npx)\\s+(?:${prefixAlternation})\\b|(?:${prefixAlternation})\\b)`,
  );

  if (!cliPrefixRe.test(normalizedCommand)) return normalizedCommand;
  if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  return normalizedCommand.replace(cliPrefixRe, (match) => `${match} --profile ${profile}`);
}

/**
 * Configuration for the agent-kit daemon and CLI.
 *
 * The agent's identity is ONE variable: OFFICE_AGENT_NAME (lowercase
 * slug, e.g. `finch`). It drives the display/service name
 * (`<agent>-side`), the default token file
 * (`~/.config/single-office/<agent>-token`), and the default
 * push-secret file (`~/.config/single-office/<agent>-push-secret`).
 * It is REQUIRED — loadConfig() fails fast with a clear message when
 * it is missing, because a wrong default (e.g. another agent's
 * token file) would be worse than no default. Everything else has
 * a default (see loadConfig): one agent per VM, port 8789, dirs
 * under the kit directory.
 *
 * The office token is NEVER stored in this directory and NEVER printed.
 * It comes from the environment (OFFICE_AGENT_TOKEN) or from a file
 * (OFFICE_TOKEN_FILE, default ~/.config/single-office/<agent>-token,
 * mode 600). Veo copies the one-time token into the Secure Vault; the
 * file is created from the vault value, never from chat (Q-07).
 *
 * The push secret is optional (WS is the primary mode, Q-14): it is
 * only needed if the §8.4 push endpoint is ever used. Same rules as
 * the token — env (OFFICE_PUSH_SECRET) or file (OFFICE_PUSH_SECRET_FILE,
 * default ~/.config/single-office/<agent>-push-secret). There is also
 * a vault provider (custom.single-office-push, src/vault.js
 * resolvePushSecret) — but a vault surrogate can NEVER serve as the
 * HMAC key (HMACs are verified locally; surrogates are only swapped
 * on outbound requests), so the vault is a presence proof and the
 * daemon fails closed when it is the only source. See RUNBOOK.md §9.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_KIT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Browser User-Agent. Cloudflare blocks non-browser user agents
 * (403, error 1010) on office.sailox.my.id, so every request from
 * this VM — REST, health checks, and the connector helper — must
 * carry it. Verified live 2026-11-16.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * The agent's slug (lowercase, e.g. `finch`). Required — there is no
 * safe default: defaulting to another agent's name would silently
 * read that agent's token file. Throws ConfigError with the fix.
 */
export function agentName(env = process.env) {
  const raw = typeof env.OFFICE_AGENT_NAME === "string" ? env.OFFICE_AGENT_NAME.trim().toLowerCase() : "";
  if (/^[a-z][a-z0-9-]*$/.test(raw)) return raw;
  throw new ConfigError(
    "No agent name: set OFFICE_AGENT_NAME to your agent's lowercase name " +
      "(e.g. OFFICE_AGENT_NAME=finch). See SETUP.md — it drives the token " +
      "file, the push-secret file, and the service name.",
  );
}

export function defaultTokenFile(env = process.env) {
  return join(homedir(), ".config", "single-office", `${agentName(env)}-token`);
}

export function defaultPushSecretFile(env = process.env) {
  return join(homedir(), ".config", "single-office", `${agentName(env)}-push-secret`);
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function readSecretFile(path, label) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") {
    throw new ConfigError(`${label} file is empty: ${path}`);
  }
  if (/\s/.test(raw)) {
    throw new ConfigError(`${label} file must contain a single token (no whitespace): ${path}`);
  }
  return raw;
}

/**
 * Read the office token. Env wins over the file. Throws ConfigError
 * when there is no token at all — the daemon fails fast with a clear
 * message instead of retrying forever (see RUNBOOK.md).
 */
export function loadToken(env = process.env) {
  if (typeof env.OFFICE_AGENT_TOKEN === "string" && env.OFFICE_AGENT_TOKEN.trim() !== "") {
    return env.OFFICE_AGENT_TOKEN.trim();
  }
  const file = env.OFFICE_TOKEN_FILE ?? defaultTokenFile(env);
  const fromFile = readSecretFile(file, "Office token");
  if (fromFile) return fromFile;
  throw new ConfigError(
    "No office token: set OFFICE_AGENT_TOKEN or create the token file " +
      `(OFFICE_TOKEN_FILE, default ${defaultTokenFile(env)}). ` +
      "Veo provides the one-time token via the Secure Vault (Q-07) — " +
      "never paste it in chat.",
  );
}

/** Read the push secret, or null when it is not configured (WS mode). */
export function loadPushSecret(env = process.env) {
  if (typeof env.OFFICE_PUSH_SECRET === "string" && env.OFFICE_PUSH_SECRET.trim() !== "") {
    return env.OFFICE_PUSH_SECRET.trim();
  }
  const file = env.OFFICE_PUSH_SECRET_FILE ?? defaultPushSecretFile(env);
  return readSecretFile(file, "Push secret");
}

export function loadConfig(env = process.env) {
  const name = agentName(env);
  const baseUrl = (env.OFFICE_BASE_URL ?? "https://office.sailox.my.id").replace(/\/+$/, "");
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`OFFICE_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`OFFICE_BASE_URL must be http(s): ${baseUrl}`);
  }
  const localPort = Number(env.AGENT_LOCAL_PORT ?? "8789");
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new ConfigError(`AGENT_LOCAL_PORT must be a port number: ${env.AGENT_LOCAL_PORT ?? "8789"}`);
  }
  const kitDir = env.AGENT_KIT_DIR ? resolve(env.AGENT_KIT_DIR) : AGENT_KIT_DIR;
  return {
    baseUrl,
    localPort,
    agentName: name,
    serviceName: `${name}-side`,
    kitDir,
    inboxDir: join(kitDir, "inbox"),
    readDir: join(kitDir, "read"),
    stateDir: join(kitDir, "state"),
    pushSkewSeconds: Number(env.PUSH_SKEW_SECONDS ?? "300"),
    wsReconnectBaseMs: Number(env.WS_RECONNECT_BASE_MS ?? "1000"),
    wsReconnectMaxMs: Number(env.WS_RECONNECT_MAX_MS ?? "60000"),
  };
}

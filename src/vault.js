/**
 * Vault-backed token resolution for the agent-kit daemon and CLI.
 *
 * The office token lives ONLY in the Secure Vault as the registered
 * connection custom.single-office (Q-07). It is never written to a
 * file, never printed, never passed as an argument. Each call fetches
 * a FRESH surrogate (hsurr:...) from authd — a placeholder Sentinel
 * swaps for the real token on approved egress to office.sailox.my.id.
 * The surrogate string itself is never logged (log only that one was
 * obtained or refreshed).
 *
 * Precedence: a real token from env or the token file wins (a token
 * supplied outside the vault). The vault is used only when neither
 * is configured. A malformed token file still fails fast — the vault
 * does not mask it.
 *
 * The push secret (custom.single-office-push) follows the same
 * precedence — env, then file, then the office (resolvePushSecretViaOffice
 * fetches the agent's own secret from GET /api/v1/agent/push-secret),
 * then vault — but with one hard limit: a surrogate can NEVER serve
 * as the HMAC key. Push HMACs are verified locally in-process
 * (src/push.js), and Sentinel swaps a surrogate for the real value
 * only on an approved outbound request; a push secret is never sent
 * anywhere, so there is nothing to swap it in. Using a surrogate
 * as the key would make EVERY push fail 401 "invalid signature".
 * resolvePushSecret therefore fetches the surrogate only to prove
 * the secret is stored, then FAILS CLOSED (ConfigError) when no real
 * secret is configured — the daemon answers 503 not_configured and
 * logs why, instead of failing every push with a misleading 401.
 * The office fetch is the delivery channel that closes the gap:
 * the secret arrives over authenticated REST, so it is a real key.
 * See RUNBOOK.md §9.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_KIT_DIR,
  defaultTokenFile,
  defaultPushSecretFile,
  loadToken,
  loadPushSecret,
  ConfigError,
} from "./config.js";

export const VAULT_CREDENTIAL = "custom.single-office";
export const VAULT_PUSH_CREDENTIAL = "custom.single-office-push";

// The vault provider slugs are SHARED, not per-agent: every AI has
// its own vault instance of the same two connectors
// (custom.single-office for the token, custom.single-office-push for
// the push-secret presence check). Do NOT "fix" these to include the
// agent name — the per-agent part is the credential VALUE in each
// AI's own vault, never the slug. See README.md ("Vault slugs").

function surrogateScript() {
  return join(AGENT_KIT_DIR, "bin", "get-surrogate.py");
}

function pushSecretScript() {
  return join(AGENT_KIT_DIR, "bin", "get-push-secret-surrogate.py");
}

/** Fetch one fresh surrogate from authd. Throws on any failure. */
export function getVaultSurrogate() {
  let out;
  try {
    out = execFileSync("python3", [surrogateScript()], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = String(err.stderr ?? err.message ?? err).trim().split("\n")[0];
    throw new ConfigError(
      `cannot obtain an office token surrogate from the vault: ${detail}`,
    );
  }
  const surrogate = String(out).trim();
  if (!surrogate.startsWith("hsurr:")) {
    throw new ConfigError(
      "vault returned a non-surrogate value for custom.single-office",
    );
  }
  return surrogate;
}

/** A surrogate token is a placeholder, not the real credential. */
export function isSurrogate(token) {
  return typeof token === "string" && token.startsWith("hsurr:");
}

/** Where the token comes from: "env" | "file" | "vault". */
export function tokenSource(env = process.env) {
  if (
    typeof env.OFFICE_AGENT_TOKEN === "string" &&
    env.OFFICE_AGENT_TOKEN.trim() !== ""
  ) {
    return "env";
  }
  const file = env.OFFICE_TOKEN_FILE ?? defaultTokenFile(env);
  if (existsSync(file)) return "file";
  return "vault";
}

/**
 * Resolve the office token: env/file first, vault surrogate when
 * nothing is configured. Throws ConfigError when no source works.
 */
export function resolveToken(env = process.env) {
  if (tokenSource(env) !== "vault") return loadToken(env);
  return getVaultSurrogate();
}

/**
 * Fetch one fresh push-secret surrogate from authd. Throws on any
 * failure. The surrogate is a presence proof, NOT a usable HMAC key
 * (see the header comment) — callers must never pass it to
 * verifyPush. `execFn` exists only so tests can mock the subprocess.
 */
export function getVaultPushSecretSurrogate(execFn = execFileSync) {
  let out;
  try {
    out = execFn("python3", [pushSecretScript()], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = String(err.stderr ?? err.message ?? err).trim().split("\n")[0];
    throw new ConfigError(
      `cannot obtain a push secret surrogate from the vault: ${detail}`,
    );
  }
  const surrogate = String(out).trim();
  if (!surrogate.startsWith("hsurr:")) {
    throw new ConfigError(
      "vault returned a non-surrogate value for custom.single-office-push",
    );
  }
  return surrogate;
}

/**
 * Resolve the push secret: env, then file, then vault — in that
 * order, fresh on every call (the daemon calls this on every
 * POST /push, so a changed value is picked up with no restart).
 * A malformed secret file fails fast and is never masked by the
 * vault. When the only source is the vault, the surrogate is fetched
 * (proving the secret is stored) and then refused: a surrogate
 * cannot verify HMACs, so this throws instead of returning a key
 * that would fail every push with 401. The thrown message never
 * contains the surrogate value. `fetchSurrogate` exists only so
 * tests can mock the vault call.
 */
export function resolvePushSecret(env = process.env, { fetchSurrogate = getVaultPushSecretSurrogate } = {}) {
  const fromEnvOrFile = loadPushSecret(env);
  if (fromEnvOrFile) return fromEnvOrFile;
  fetchSurrogate();
  // The default file path in this message needs the agent name; if
  // the caller never set one, fall back to the placeholder form
  // rather than failing with a different error than the fail-closed
  // one this function exists to throw.
  let defaultFile;
  try {
    defaultFile = defaultPushSecretFile(env);
  } catch {
    defaultFile = "~/.config/single-office/<agent>-push-secret";
  }
  throw new ConfigError(
    "Push secret is stored in the Secure Vault (custom.single-office-push) " +
    "but a vault surrogate cannot verify push HMACs — place the real secret " +
    "in OFFICE_PUSH_SECRET or the secret file " +
    `(OFFICE_PUSH_SECRET_FILE, default ${defaultFile}). ` +
    "The secret must match the push secret set in the office (/admin/agents) exactly.",
  );
}

/**
 * Resolve the push secret with the office as a source: env, then
 * file, then the office (GET /api/v1/agent/push-secret — the agent's
 * own secret, fetched fresh on every call), then the vault. The
 * office fetch is the delivery channel the vault cannot be: the
 * value arrives over an authenticated REST call (the Bearer token
 * proves who the agent is), so it is a real key, not a surrogate.
 * A failed office fetch (office unreachable, token bad, no secret
 * set) is logged — message only, never a secret — and falls through
 * to the vault fail-closed path, which throws instead of returning a
 * surrogate as a key. The daemon calls this on every POST /push, so
 * a rotation in /admin/agents is picked up with no restart.
 * `rest` is an OfficeRest (duck-typed: needs pushSecret()).
 * `fetchSurrogate` exists only so tests can mock the vault call.
 */
export async function resolvePushSecretViaOffice(env = process.env, rest, { fetchSurrogate = getVaultPushSecretSurrogate } = {}) {
  const fromEnvOrFile = loadPushSecret(env);
  if (fromEnvOrFile) return fromEnvOrFile;
  try {
    const data = await rest.pushSecret();
    const fromOffice = data?.push_secret;
    if (typeof fromOffice === "string" && fromOffice !== "") return fromOffice;
  } catch (err) {
    console.error(`office push-secret fetch failed: ${err.message ?? err}`);
  }
  return resolvePushSecret(env, { fetchSurrogate });
}

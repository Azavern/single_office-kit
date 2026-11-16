/**
 * Agent-kit daemon: holds the office connection, receives messages,
 * files them in the mailbox, and wakes the agent (via the hook that
 * watches inbox/).
 *
 * - Primary mode: outbound WS (office-ws.js, Q-14). The daemon
 *   connects out to the office; the office never connects in.
 * - Local HTTP server (127.0.0.1 only): GET /health, GET /inbox,
 *   POST /push (the §8.4 receiver — localhost only; the office
 *   can reach it only if this VM has a public URL, see README.md).
 * - On a delivery (WS or push): store in the mailbox (dedupe by
 *   delivery id), ack it over WS when connected (tick 1: received),
 *   log WAKE. The agent's reply comes later, through the CLI/REST.
 * - The process never exits on WS trouble (reconnect with backoff,
 *   token re-read each attempt). It exits only on fatal config
 *   (no token, port taken) or on SIGTERM/SIGINT.
 */
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { resolveToken, resolvePushSecretViaOffice } from "./vault.js";
import { Mailbox } from "./mailbox.js";
import { handlePush } from "./push.js";
import { OfficeRest } from "./office-rest.js";
import { OfficeWs } from "./office-ws.js";

export class AgentDaemon {
  constructor(config, { getToken = () => resolveToken(), getPushSecret, env = process.env } = {}) {
    this.config = config;
    this.env = env;
    this.getToken = getToken;
    this.startedAt = new Date();
    this.mailbox = new Mailbox({
      inboxDir: config.inboxDir,
      readDir: config.readDir,
      stateDir: config.stateDir,
    });
    this.rest = new OfficeRest(config.baseUrl, () => this.getToken());
    // Default push-secret source: env → file → office (the agent's
    // own secret, fetched fresh on every POST /push, so a rotation
    // in /admin/agents is picked up with no restart) → vault
    // (presence check only, fail-closed — a surrogate is never a
    // HMAC key). Callers (tests) may override getPushSecret.
    this.getPushSecret = getPushSecret ?? (() => resolvePushSecretViaOffice(this.env, this.rest));
    this.ws = new OfficeWs(config.baseUrl, () => this.getToken(), {
      reconnectBaseMs: config.wsReconnectBaseMs,
      reconnectMaxMs: config.wsReconnectMaxMs,
    });
    this.http = null;
    this.pidFile = join(config.stateDir, "daemon.pid");
  }

  #log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
  }

  /** Store + ack one delivery. Returns { stored, duplicate }. */
  handleDelivery(envelope, { via = "ws" } = {}) {
    const deliveryId = envelope?.deliveryId;
    if (typeof deliveryId !== "string" || deliveryId === "") {
      console.error("delivery without deliveryId — dropped", JSON.stringify(envelope)?.slice(0, 200));
      return { stored: false };
    }
    const stored = this.mailbox.store(deliveryId, envelope);
    if (!stored.stored) {
      this.#log(`DUPLICATE delivery=${deliveryId} (already filed, no second wake)`);
      // Still ack a duplicate WS delivery: the office is waiting on
      // THIS dispatch (a new waiter per dispatch). Dedupe means "no
      // second wake", not "no ack" — the message WAS received.
      if (via === "ws" && this.ws.connected) {
        try {
          this.ws.ackDelivery(deliveryId);
        } catch {}
      }
      return stored;
    }
    const msg = envelope.message ?? {};
    this.#log(`WAKE delivery=${deliveryId} message=${msg.id ?? "?"} room=${msg.roomId ?? "?"} from=${msg.from?.name ?? msg.from?.id ?? "?"}`);
    if (typeof msg.body === "string" && msg.body !== "") {
      this.#log(`  body: ${msg.body.slice(0, 200)}`);
    }
    // WS deliveries are acked over WS (tick 1). Push deliveries are
    // already acked by the 202 response — a second WS ack would be a
    // no-op on the office side, so it is skipped on purpose.
    if (via === "ws" && this.ws.connected) {
      try {
        this.ws.ackDelivery(deliveryId);
      } catch (err) {
        console.error(`ack failed for ${deliveryId}:`, err.message ?? err);
      }
    }
    return stored;
  }

  #readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  #json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  async #handleHttp(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      this.#json(res, 200, {
        ok: true,
        service: this.config.serviceName,
        mode: "ws-outbound",
        wsConnected: this.ws.connected,
        inboxPending: this.mailbox.listPending().length,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
        startedAt: this.startedAt.toISOString(),
      });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/inbox")) {
      if (url.pathname === "/") {
        this.#json(res, 200, {
          service: this.config.serviceName,
          push_endpoint: "/push (localhost only — the office can reach it only if this VM has a public URL)",
          wsConnected: this.ws.connected,
          received: this.mailbox.listPending().length,
        });
        return;
      }
      this.#json(res, 200, { pending: this.mailbox.listPending() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/push") {
      let secret = null;
      try {
        secret = await this.getPushSecret();
      } catch (err) {
        // The message names the source (env/file/vault) but never
        // contains a secret value; log it so a misconfigured push
        // secret is diagnosable from the daemon log. The HTTP answer
        // stays a generic 503 — the caller is the office over the
        // public tunnel, and it must not learn internals.
        console.error(`push secret unavailable: ${err.message ?? err}`);
        secret = null;
      }
      if (!secret) {
        this.#json(res, 503, { error: { code: "not_configured", message: "Push secret is not configured (WS is the primary mode)." } });
        return;
      }
      const rawBody = await this.#readBody(req);
      const headers = {
        "x-office-delivery": req.headers["x-office-delivery"],
        "x-office-timestamp": req.headers["x-office-timestamp"],
        "x-office-signature": req.headers["x-office-signature"],
      };
      const result = handlePush({
        headers,
        rawBody,
        secret,
        skewSeconds: this.config.pushSkewSeconds,
        store: (id, env) => this.mailbox.store(id, env),
      });
      if (result.status !== 202) {
        this.#json(res, result.status, { error: { code: "invalid_request", message: result.error } });
        return;
      }
      if (result.envelope) this.handleDelivery(result.envelope, { via: "push" });
      res.writeHead(202);
      res.end();
      return;
    }
    this.#json(res, 404, { error: { code: "not_found", message: "Not found." } });
  }

  async start() {
    mkdirSync(this.config.stateDir, { recursive: true });
    writeFileSync(this.pidFile, String(process.pid), "utf8");
    this.ws
      .on("delivery", (envelope) => this.handleDelivery(envelope))
      .on("connect", () => this.#log("WS connected to office"))
      .on("disconnect", () => this.#log("WS disconnected (reconnecting with backoff)"))
      .on("unauthorized", (detail) => this.#log(`WS auth refused: ${detail} (check the token; retrying with backoff)`));
    this.http = createServer((req, res) => {
      this.#handleHttp(req, res).catch((err) => {
        console.error("local http handler failed", err);
        if (!res.headersSent) this.#json(res, 500, { error: { code: "internal", message: "Internal error." } });
      });
    });
    await new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.localPort, "127.0.0.1", resolve);
    });
    this.#log(`${this.config.serviceName} listening on http://127.0.0.1:${this.config.localPort} (health, inbox, push)`);
    // Connect in the background: start() must not block on the office.
    this.ws.connect().catch((err) => {
      this.#log(`WS first connect failed: ${err.message} (retrying in background)`);
    });
    const shutdown = () => {
      this.#log("shutting down");
      this.ws.disconnect();
      this.http.close(() => {
        try {
          rmSync(this.pidFile, { force: true });
        } catch {}
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 2000).unref?.();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return this;
  }
}

/** Boot the daemon from the environment (CLI entry). */
export async function runDaemon(env = process.env) {
  const config = loadConfig(env);
  // Fail fast when there is no token at all — nothing to retry.
  // resolveToken tries env/file first, then the vault (a fresh
  // surrogate per call); it throws when no source works.
  resolveToken(env);
  const daemon = new AgentDaemon(config, {
    getToken: () => resolveToken(env),
    env,
  });
  await daemon.start();
  return daemon;
}

/**
 * Mock office for tests: a tiny HTTP server (REST) + a WebSocket
 * server speaking the Engine.IO v4 / Socket.IO v5 wire protocol
 * (the same bytes the real office gateway speaks).
 *
 * REST: canned routes for me/name/rooms/messages/state/realtime-info,
 * with a Bearer token check ("test-token" is valid).
 * WS: sends the Engine.IO open packet, accepts 40{"token":...}
 * (valid → 40{"sid"}, else 44 unauthorized), records delivery acks,
 * answers message.send / join with 43 acks, can push deliveries to
 * the client, can send Engine.IO pings.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export const TEST_TOKEN = "test-token-soa_123";

/**
 * A surrogate-shaped token for the header-auth tests. The mock
 * accepts it ONLY as an Authorization header with an empty CONNECT
 * packet — exactly like the real gateway (which prefers the packet
 * token, so a surrogate in the packet would arrive unswapped and be
 * refused).
 */
export const TEST_SURROGATE = "hsurr:test-surrogate-1";

export function makeEnvelope(overrides = {}) {
  return {
    deliveryId: overrides.deliveryId ?? "del_test_1",
    message: {
      id: overrides.messageId ?? "msg_test_1",
      roomId: overrides.roomId ?? "room_test_1",
      from: { type: "user", id: "user_veo", name: "veo" },
      body: overrides.body ?? "halo TestAgent",
      createdAt: new Date().toISOString(),
      fileIds: [],
    },
    wake: true,
  };
}

export class MockOffice {
  constructor() {
    this.acks = [];
    this.receivedSends = [];
    this.joins = [];
    this.restCalls = [];
    this.clients = new Set();
    // The agent's own push-signing secret (§8.4), as the real office
    // returns it from GET /api/v1/agent/push-secret. Tests may set
    // it (rotation) or clear it (null → no secret configured).
    this.pushSecret = "office-push-secret";
    // CONNECT packets seen (raw payload after "4") and how each
    // connection authenticated: { via: "packet" | "header" }.
    this.connectPackets = [];
    this.connectAuth = [];
    this.http = createServer((req, res) => this.#handleRest(req, res));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws, req) => this.#handleWs(ws, req));
  }

  async listen() {
    await new Promise((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    this.port = this.http.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async close() {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {}
    }
    await new Promise((resolve) => this.wss.close(resolve));
    await new Promise((resolve) => this.http.close(resolve));
  }

  #json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  #readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  async #handleRest(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization ?? "";
    const authed = auth === `Bearer ${TEST_TOKEN}`;
    this.restCalls.push({ method: req.method, path: url.pathname, userAgent: req.headers["user-agent"] ?? "" });
    if (url.pathname === "/api/health") {
      this.#json(res, 200, { ok: true });
      return;
    }
    if (!authed) {
      this.#json(res, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/agent/me") {
      this.#json(res, 200, {
        id: "agent_test",
        name: "TestAgent",
        role: "test-role",
        scopes: ["rooms.create", "files.upload"],
        reports_to: null,
        push_endpoint: null,
        has_push_secret: false,
        created_at: "2026-11-16T00:00:00.000Z",
        name_updated_at: null,
        disabled_at: null,
        last_seen_at: null,
        tokens: [],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/agent/push-secret") {
      this.#json(res, 200, { push_secret: this.pushSecret });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/agent/name") {
      const body = JSON.parse(await this.#readBody(req));
      if (["Veo", "Ryn", "System", "Office", "Admin"].includes(body.name)) {
        this.#json(res, 403, { error: { code: "forbidden", message: "Nama dilarang." } });
        return;
      }
      this.#json(res, 200, { id: "agent_test", name: body.name, role: "test-role", scopes: [] });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/rooms") {
      const body = JSON.parse(await this.#readBody(req));
      if (!body.participants || body.participants.length < 2) {
        this.#json(res, 400, { error: { code: "invalid_request", message: "room butuh minimal dua peserta." } });
        return;
      }
      this.#json(res, 201, {
        id: "room_main_1",
        kind: body.kind,
        title: body.title ?? null,
        participants: [...body.participants, { type: "agent", id: "agent_test" }],
        created_at: new Date().toISOString(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/rooms") {
      this.#json(res, 200, { rooms: [{ id: "room_main_1", kind: "main", title: null }] });
      return;
    }
    const msgMatch = url.pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/messages$/);
    if (msgMatch) {
      if (req.method === "GET") {
        this.#json(res, 200, { room: { id: msgMatch[1] }, messages: [], has_older: false });
        return;
      }
      if (req.method === "POST") {
        const body = JSON.parse(await this.#readBody(req));
        this.#json(res, 201, {
          message: { id: "msg_reply_1", room_id: msgMatch[1], body: body.body, sender_type: "agent", sender_id: "agent_test" },
        });
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/v1/agent/state") {
      const body = JSON.parse(await this.#readBody(req));
      this.#json(res, 200, { agent_id: "agent_test", state: body.state, last_seen_at: new Date().toISOString() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/realtime/info") {
      this.#json(res, 200, { provider: "socketio", mode: "ws", timezone: "Asia/Makassar" });
      return;
    }
    this.#json(res, 404, { error: { code: "not_found", message: "Not found." } });
  }

  #handleWs(ws, req) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    // The Authorization header on the WS upgrade request (if any).
    // The real gateway reads it when the CONNECT packet carries no
    // token (authToken ?? headerToken).
    const upgradeAuth = req?.headers?.authorization ?? "";
    ws.send(`0{"sid":"mock-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}`);
    ws.on("message", (raw) => {
      const data = raw.toString();
      if (data === "3") return; // pong
      if (!data.startsWith("4")) return;
      const payload = data.slice(1);
      if (payload.startsWith("0")) {
        let auth = {};
        try {
          auth = JSON.parse(payload.slice(1));
        } catch {}
        this.connectPackets.push(payload);
        if (auth.token === TEST_TOKEN) {
          // Real token in the CONNECT packet; no header expected.
          this.connectAuth.push({ via: "packet", header: upgradeAuth });
          ws.send(`40{"sid":"mock-socket"}`);
        } else if (
          (auth.token === undefined || auth.token === null) &&
          (upgradeAuth === `Bearer ${TEST_SURROGATE}` || upgradeAuth === `Bearer ${TEST_TOKEN}`)
        ) {
          // Empty CONNECT packet + header auth (the surrogate path).
          this.connectAuth.push({ via: "header", header: upgradeAuth });
          ws.send(`40{"sid":"mock-socket"}`);
        } else {
          // Includes a surrogate in the packet (unswapped → refused,
          // exactly like the real gateway) and any other bad token.
          this.connectAuth.push({ via: "refused", header: upgradeAuth });
          ws.send(`44{"message":"unauthorized"}`);
          ws.close();
        }
        return;
      }
      if (payload.startsWith("2")) {
        const rest = payload.slice(1);
        const jsonStart = rest.search(/[\[{]/);
        const ackMatch = rest.slice(0, jsonStart).match(/^(\d+)$/);
        const ackId = ackMatch ? Number(ackMatch[1]) : null;
        let parsed;
        try {
          parsed = JSON.parse(rest.slice(jsonStart));
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;
        const [name, arg] = parsed;
        if (name === "delivery.ack") {
          this.acks.push(arg);
          return;
        }
        if (name === "message.send") {
          this.receivedSends.push(arg);
          if (ackId !== null) {
            ws.send(`43${ackId}[${JSON.stringify({ ok: true, message: { id: "msg_sent_1", room_id: arg.roomId, body: arg.body } })}]`);
          }
          return;
        }
        if (name === "join") {
          this.joins.push(arg);
          if (ackId !== null) {
            ws.send(`43${ackId}[${JSON.stringify({ ok: true, channel: arg })}]`);
          }
          return;
        }
      }
    });
  }

  /** Push one delivery to every connected client (server → client). */
  pushDelivery(envelope) {
    const event = { v: 1, id: `evt_${Date.now()}`, type: "delivery", channel: "agent:agent_test", ts: new Date().toISOString(), data: envelope };
    for (const ws of this.clients) {
      ws.send(`42${JSON.stringify(["message", event])}`);
    }
  }

  /** Send an Engine.IO ping; the client must answer with a pong. */
  sendPing() {
    for (const ws of this.clients) {
      ws.send("2");
    }
  }
}

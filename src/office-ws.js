/**
 * Outbound WS client for the office gateway — raw Engine.IO v4 +
 * Socket.IO v5 wire protocol over Node's built-in WebSocket.
 *
 * WHY NOT socket.io-client: its transports (the `ws` package and
 * `xmlhttprequest-ssl`) open direct TCP connections and bypass the
 * VM's egress proxy, so they fail here ("websocket error" /
 * "xhr poll error", verified 2026-11-16). Node's built-in WebSocket
 * and fetch honour NODE_USE_ENV_PROXY=1 and work — verified live
 * against https://office.sailox.my.id (open packet received, bad
 * token refused with 44 {"message":"unauthorized"}).
 *
 * Wire format (server.ts gateway, socket.io.ts publish):
 * - Connect: wss://<office>/socket.io/?EIO=4&transport=websocket
 * - Server → client: `0{...}` (Engine.IO open), `2` (ping → reply
 *   `3`), `40{"sid":"..."}` (Socket.IO connected),
 *   `44{"message":"unauthorized"}` (auth refused),
 *   `42["message", {v:1,type:"delivery",data:<envelope>}]`.
 * - Client → server: `40{"token":"<agent token>"}` (CONNECT+auth),
 *   `42["delivery.ack",{"deliveryId":"..."}]`,
 *   `42["message.send",{roomId,body,...},<ackId>]` → server replies
 *   `43<ackId>[{ok,message}]`,
 *   `42["join","room:<id>",<ackId>]` → `43<ackId>[{ok,channel}]`.
 *
 * Reconnect: exponential backoff (base → max), token re-read before
 * every attempt so a rotated token takes effect without a restart.
 * The client never exits on its own: auth failure just means
 * "not connected, retrying" (the runbook covers a wrong token).
 *
 * Vault surrogates (hsurr:...): a surrogate MUST NOT be sent in the
 * CONNECT packet — the gateway prefers the packet token over the
 * header (authToken ?? headerToken, server.ts), and a surrogate in a
 * WS frame would reach the office unswapped. So a surrogate travels
 * ONLY as the Authorization header on the WS upgrade request, and
 * the CONNECT packet carries an empty auth object (40{}). A real
 * token keeps the old behaviour: in the CONNECT packet, no header.
 */
import { isSurrogate } from "./vault.js";

export class OfficeWs {
  #onceConnect = null;
  #onceConnectError = null;

  constructor(baseUrl, getToken, { reconnectBaseMs = 1000, reconnectMaxMs = 60000, ackTimeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.getToken = getToken;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.ws = null;
    this.connected = false;
    this.wantConnect = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.nextAckId = 0;
    this.pendingAcks = new Map();
    this.handlers = new Map();
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  #emit(event, ...args) {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`office-ws: handler for ${event} threw`, err);
      }
    }
  }

  #wsUrl() {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = "/socket.io/";
    url.search = "?EIO=4&transport=websocket";
    return url.toString();
  }

  /**
   * Start (and keep) the connection. Resolves on first CONNECT.
   * Rejects after `timeoutMs` when no connection could be made —
   * the background retries keep going (a rotated token may fix it),
   * so a rejection means "not connected yet", never "gave up".
   */
  connect({ timeoutMs = 30000 } = {}) {
    this.wantConnect = true;
    this.reconnectAttempt = 0;
    return new Promise((resolve, reject) => {
      this.#onceConnect = resolve;
      this.#onceConnectError = reject;
      const timer = setTimeout(() => {
        if (this.#onceConnectError) {
          this.#onceConnect = null;
          this.#onceConnectError = null;
          reject(new Error("connect timeout: gateway did not accept the connection (check the token and the network)"));
        }
      }, timeoutMs);
      timer.unref?.();
      this.#connectOnce();
    });
  }

  #connectOnce() {
    if (!this.wantConnect) return;
    const attempt = this.reconnectAttempt;
    Promise.resolve()
      .then(() => this.getToken())
      .then((token) => {
        if (!this.wantConnect) return;
        // Surrogate: header-only auth (see the header comment).
        // Real token: no header, token in the CONNECT packet.
        const ws = new WebSocket(
          this.#wsUrl(),
          isSurrogate(token)
            ? { headers: { Authorization: `Bearer ${token}` } }
            : undefined,
        );
        this.ws = ws;
        let opened = false;
        ws.onopen = () => {};
        ws.onmessage = (ev) => {
          const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
          this.#onEnginePacket(data, token, () => {
            opened = true;
          });
        };
        ws.onerror = () => {
          // The close handler below reports the failure; onerror
          // alone carries no detail.
        };
        ws.onclose = () => {
          this.#onClose(opened, attempt);
        };
      })
      .catch((err) => {
        console.error(`office-ws: connect attempt ${attempt + 1} failed before open:`, err.message ?? err);
        this.#scheduleReconnect(attempt);
      });
  }

  #onEnginePacket(data, token, onOpened) {
    if (data === "2") {
      // Engine.IO ping → pong.
      try {
        this.ws?.send("3");
      } catch {}
      return;
    }
    if (data.startsWith("0{")) {
      // Engine.IO open → send Socket.IO CONNECT.
      // Surrogate: empty auth object (40{}) — the token already
      // travelled as the Authorization header on the upgrade request.
      // Real token: in the CONNECT packet, as before.
      onOpened();
      try {
        this.ws?.send(isSurrogate(token) ? "40{}" : `40${JSON.stringify({ token })}`);
      } catch {}
      return;
    }
    if (data === "1") {
      // Engine.IO close.
      try {
        this.ws?.close();
      } catch {}
      return;
    }
    if (!data.startsWith("4")) return; // 6 (noop) and anything else: ignore.
    const payload = data.slice(1);
    if (payload.startsWith("0")) {
      // Socket.IO connected: 40{"sid":"..."}.
      this.connected = true;
      this.reconnectAttempt = 0;
      this.#emit("connect");
      if (this.#onceConnect) {
        const resolve = this.#onceConnect;
        this.#onceConnect = null;
        this.#onceConnectError = null;
        resolve();
      }
      return;
    }
    if (payload.startsWith("4")) {
      // CONNECT_ERROR, e.g. 44{"message":"unauthorized"}.
      let detail = payload.slice(1);
      try {
        detail = JSON.parse(detail).message ?? detail;
      } catch {}
      this.connected = false;
      this.#emit("unauthorized", detail);
      if (this.#onceConnectError) {
        const reject = this.#onceConnectError;
        this.#onceConnect = null;
        this.#onceConnectError = null;
        reject(new Error(`unauthorized: ${detail}`));
      }
      try {
        this.ws?.close();
      } catch {}
      return;
    }
    if (payload.startsWith("2")) {
      // EVENT: 42["name", ...args] (server never asks us to ack).
      const rest = payload.slice(1);
      const jsonStart = rest.search(/[\[{]/);
      if (jsonStart === -1) return;
      let parsed;
      try {
        parsed = JSON.parse(rest.slice(jsonStart));
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return;
      const [name, ...args] = parsed;
      if (name === "message") {
        const event = args[0];
        if (event && event.type === "delivery" && event.data) {
          this.#emit("delivery", event.data);
        } else {
          this.#emit("event", event);
        }
      } else {
        this.#emit("event", { name, args });
      }
      return;
    }
    if (payload.startsWith("3")) {
      // ACK: 43<ackId>[response].
      const rest = payload.slice(1);
      const m = rest.match(/^(\d+)(.*)$/s);
      if (!m) return;
      const ackId = Number(m[1]);
      const pending = this.pendingAcks.get(ackId);
      if (!pending) return;
      this.pendingAcks.delete(ackId);
      clearTimeout(pending.timer);
      let response = null;
      try {
        const parsed = JSON.parse(m[2]);
        response = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {}
      pending.resolve(response);
      return;
    }
  }

  #onClose(opened, attempt) {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection lost"));
    }
    this.pendingAcks.clear();
    if (wasConnected || opened) this.#emit("disconnect");
    this.#scheduleReconnect(attempt);
  }

  #scheduleReconnect(attempt) {
    if (!this.wantConnect || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** attempt);
    this.reconnectAttempt = attempt + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connectOnce();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Stop reconnecting and close the socket. */
  disconnect() {
    this.wantConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  #sendPacket(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    this.ws.send(text);
  }

  /** Emit an event that expects an ack; resolves with the ack payload. */
  emitWithAck(name, data, timeoutMs = this.ackTimeoutMs) {
    return new Promise((resolve, reject) => {
      const ackId = this.nextAckId++;
      const timer = setTimeout(() => {
        this.pendingAcks.delete(ackId);
        reject(new Error(`ack timeout for ${name}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingAcks.set(ackId, { resolve, reject, timer });
      try {
        this.#sendPacket(`42${ackId}${JSON.stringify([name, data])}`);
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(ackId);
        reject(err);
      }
    });
  }

  /** Fire-and-forget emit (delivery.ack). */
  emit(name, data) {
    this.#sendPacket(`42${JSON.stringify([name, data])}`);
  }

  /** Ack one WS delivery (tick 1: received). */
  ackDelivery(deliveryId) {
    this.emit("delivery.ack", { deliveryId });
  }

  /** Join a room channel (room:<id>). Resolves with the join ack. */
  joinRoom(roomId) {
    return this.emitWithAck("join", `room:${roomId}`);
  }

  /** Send a message over WS (same validation as the REST route). */
  sendMessage(roomId, { body, replyToId, clientMsgId }) {
    return this.emitWithAck("message.send", {
      roomId,
      body,
      ...(replyToId ? { reply_to_id: replyToId } : {}),
      ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
    });
  }
}

/**
 * REST client for the office API (Bearer soa_… token, Q-07).
 *
 * Every call re-reads the token through `getToken()` so a rotated
 * token takes effect without restarting the daemon. All calls use
 * the global fetch (undici), which honours the VM's egress proxy
 * (NODE_USE_ENV_PROXY=1) — unlike socket.io-client's transports.
 *
 * Error shape: OfficeError with .status and the office's
 * { error: { code, message } } when the office sent one.
 */
import { BROWSER_USER_AGENT } from "./config.js";

export class OfficeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "OfficeError";
    this.status = status;
    this.code = code;
  }
}

export class OfficeRest {
  constructor(baseUrl, getToken) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.getToken = getToken;
  }

  async request(path, { method = "GET", body } = {}) {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        // Browser UA: Cloudflare blocks non-browser UAs (1010) on
        // this host. A vault surrogate in the header is swapped by
        // Sentinel on egress; the UA is what gets the request past
        // Cloudflare in the first place.
        "User-Agent": BROWSER_USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new OfficeError(res.status, err.code ?? "http_error", err.message ?? `HTTP ${res.status}`);
    }
    return data;
  }

  /** GET /api/v1/agent/me — who am I (id, name, role, scopes). */
  me() {
    return this.request("/api/v1/agent/me");
  }

  /**
   * GET /api/v1/agent/push-secret — the agent's OWN push-signing
   * secret (§8.4), or { push_secret: null } when none is set. This
   * is the delivery channel for the HMAC key: the value arrives
   * over this authenticated REST call (the Bearer token proves who
   * the agent is), so it is a real key — unlike a vault surrogate,
   * which can never serve as an HMAC key because a push secret is
   * never sent anywhere (see vault.js).
   */
  pushSecret() {
    return this.request("/api/v1/agent/push-secret");
  }

  /** PUT /api/v1/agent/name — self-naming (reserved names refused, N-04: the agent's name comes from Veo's override, not this call). */
  setName(name) {
    return this.request("/api/v1/agent/name", { method: "PUT", body: { name } });
  }

  /** POST /api/v1/rooms — needs the rooms.create grant. participants: [{type:"user"|"agent", id}]. */
  createRoom({ kind, title, participants }) {
    return this.request("/api/v1/rooms", {
      method: "POST",
      body: { kind, title, participants },
    });
  }

  /** GET /api/v1/rooms — rooms the caller belongs to. */
  listRooms() {
    return this.request("/api/v1/rooms");
  }

  /** GET /api/v1/rooms/{id}/messages — history (newest first page). */
  listMessages(roomId, { limit = 35 } = {}) {
    return this.request(`/api/v1/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`);
  }

  /** POST /api/v1/rooms/{id}/messages — send {body, reply_to_id?, client_msg_id?}. */
  sendMessage(roomId, { body, replyToId, clientMsgId }) {
    return this.request(`/api/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: {
        body,
        ...(replyToId ? { reply_to_id: replyToId } : {}),
        ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
      },
    });
  }

  /** POST /api/v1/agent/state — report online | working (Q-28, N-05). */
  setState(state) {
    return this.request("/api/v1/agent/state", { method: "POST", body: { state } });
  }

  /** GET /api/v1/realtime/info — which realtime mode the office runs. */
  realtimeInfo() {
    return this.request("/api/v1/realtime/info");
  }
}

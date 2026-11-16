/**
 * §8.4 push receiver — the office's signed POST, verified here.
 *
 * The office sends:
 *   POST <push endpoint>  (Veo sets the URL per AI, Q-11)
 *   X-Office-Delivery: <delivery id>
 *   X-Office-Timestamp: <unix seconds>
 *   X-Office-Signature: v1=<hex HMAC-SHA256(secret, ts + "." + deliveryId + "." + rawBody)>
 *   Body: {deliveryId, message:{id, roomId, from:{type,id,name}, body,
 *   replyToId?, createdAt, fileIds?}, wake:true} — exactly what the
 *   office's buildEnvelope sends (Blueprint §8.4, stub-ai-server).
 *
 * The receiver must: verify signature + timestamp skew (else 401),
 * dedupe on the delivery id (redelivery → 202, no second wake),
 * store the envelope, answer 202 fast, then wake the agent.
 * Malformed envelope → 400. Malformed JSON → 400.
 *
 * NOTE: from this VM the push endpoint is NOT reachable by the
 * office unless the VM has a public URL (no public HTTPS — see
 * README.md and tunnel/). This handler exists so the daemon speaks
 * the full contract locally (tests, and a future public URL if Veo
 * ever provisions one). The live mode is the outbound WS client
 * (office-ws.js), unless a push path is set up per SETUP.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function signPush(secret, timestamp, deliveryId, rawBody) {
  return (
    "v1=" +
    createHmac("sha256", secret)
      .update(`${timestamp}.${deliveryId}.${rawBody}`)
      .digest("hex")
  );
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a push request. Returns { ok: true, envelope } or
 * { ok: false, status, error }.
 */
export function verifyPush({ headers, rawBody, secret, skewSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const deliveryId = headers["x-office-delivery"];
  const timestamp = headers["x-office-timestamp"];
  const signature = headers["x-office-signature"];
  if (!deliveryId || !timestamp || !signature) {
    return { ok: false, status: 401, error: "missing X-Office-Delivery, X-Office-Timestamp or X-Office-Signature" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 401, error: "invalid timestamp" };
  }
  if (Math.abs(nowSeconds - ts) > skewSeconds) {
    return { ok: false, status: 401, error: "timestamp outside the allowed skew" };
  }
  const expected = signPush(secret, timestamp, deliveryId, rawBody);
  if (!safeEqual(signature, expected)) {
    return { ok: false, status: 401, error: "invalid signature" };
  }
  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error: "body is not JSON" };
  }
  // Envelope shape: the office's real envelope is
  // {deliveryId, message: {id, roomId, from: {type, id, name}, body,
  // replyToId?, createdAt, fileIds?}, wake: true} — it has NO
  // top-level `type`. The stub and Blueprint §8.4 were corrected to
  // this shape 2026-11-16 (Veo's decision: fix the docs, not the
  // office). This daemon still accepts the old documented
  // {"type":"message"} shape too, as defensive tolerance for any AI
  // built from the old docs: a `type` that IS present must be
  // "message". The delivery id is authoritative from the header (the
  // HMAC covers it); the message shape accepts both the office's
  // camelCase (roomId, from object) and the stub's old snake_case
  // (room_id, from string) spellings.
  if (envelope === null || typeof envelope !== "object") {
    return { ok: false, status: 400, error: "envelope is not an object" };
  }
  if (typeof envelope.type === "string" && envelope.type !== "message") {
    return { ok: false, status: 400, error: "unknown envelope type" };
  }
  const message = envelope.message;
  const roomId =
    message !== null && typeof message === "object"
      ? (message.roomId ?? message.room_id)
      : undefined;
  if (
    envelope.wake !== true ||
    message === null ||
    typeof message !== "object" ||
    typeof message.id !== "string" ||
    typeof roomId !== "string"
  ) {
    return { ok: false, status: 400, error: "envelope is not a message delivery" };
  }
  return { ok: true, deliveryId, envelope };
}

/**
 * Handle one push POST end to end. `store` is Mailbox.store.
 * Returns { status, duplicate?, error? } — the HTTP status to answer.
 */
export function handlePush({ headers, rawBody, secret, skewSeconds, nowSeconds, store }) {
  const verified = verifyPush({ headers, rawBody, secret, skewSeconds, nowSeconds });
  if (!verified.ok) {
    return { status: verified.status, error: verified.error };
  }
  const stored = store(verified.deliveryId, verified.envelope);
  if (!stored.stored) {
    return { status: 202, duplicate: true };
  }
  return { status: 202, envelope: verified.envelope, deliveryId: verified.deliveryId };
}

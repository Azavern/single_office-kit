import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signPush, verifyPush, handlePush } from "../src/push.js";

const SECRET = "test-push-secret";
const NOW = 1794790000;

function headersFor(deliveryId, body, { secret = SECRET, ts = NOW, skew = 300 } = {}) {
  const timestamp = String(ts);
  return {
    "x-office-delivery": deliveryId,
    "x-office-timestamp": timestamp,
    "x-office-signature": signPush(secret, timestamp, deliveryId, body),
  };
}

const BODY = JSON.stringify({
  type: "message",
  wake: true,
  message: { id: "msg_1", room_id: "room_1", from: "veo", body: "halo", reply_to_id: null, created_at: "2026-11-16T00:00:00.000Z", file_ids: [] },
});

// The office's REAL envelope (buildEnvelope, delivery.ts): no
// top-level `type` — {deliveryId, message: {id, roomId, ...}, wake}.
const REAL_BODY = JSON.stringify({
  deliveryId: "del_real_1",
  message: {
    id: "msg_1",
    roomId: "room_1",
    from: { type: "user", id: "user_veo", name: "veo" },
    body: "halo",
    createdAt: "2026-11-16T00:00:00.000Z",
    fileIds: [],
  },
  wake: true,
});

describe("push (§8.4 contract)", () => {
  it("accepts a correctly signed delivery", () => {
    const r = verifyPush({ headers: headersFor("del_1", BODY), rawBody: BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.deliveryId, "del_1");
    assert.equal(r.envelope.type, "message");
  });

  it("refuses a wrong secret (401)", () => {
    const r = verifyPush({ headers: headersFor("del_1", BODY, { secret: "wrong" }), rawBody: BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it("refuses a tampered body (401)", () => {
    const headers = headersFor("del_1", BODY);
    const r = verifyPush({ headers, rawBody: BODY + " ", secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it("refuses a stale timestamp (401)", () => {
    const r = verifyPush({ headers: headersFor("del_1", BODY, { ts: NOW - 301 }), rawBody: BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it("accepts a timestamp at the skew edge", () => {
    const r = verifyPush({ headers: headersFor("del_1", BODY, { ts: NOW - 300 }), rawBody: BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, true);
  });

  it("refuses missing headers (401)", () => {
    const r = verifyPush({ headers: {}, rawBody: BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it("refuses a non-JSON body (400)", () => {
    const bad = "{not json";
    const r = verifyPush({ headers: headersFor("del_1", bad), rawBody: bad, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it("refuses an unknown envelope type (400)", () => {
    const other = JSON.stringify({ type: "ping" });
    const r = verifyPush({ headers: headersFor("del_1", other), rawBody: other, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it("accepts the office's REAL envelope (no top-level type, camelCase message)", () => {
    const r = verifyPush({ headers: headersFor("del_real_1", REAL_BODY), rawBody: REAL_BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.deliveryId, "del_real_1");
  });

  it("accepts the stub-documented envelope (type + snake_case message)", () => {
    const r = verifyPush({ headers: headersFor("del_1", BODY), rawBody: BODY, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, true);
  });

  it("refuses an envelope without a message (400)", () => {
    const noMsg = JSON.stringify({ type: "message", wake: true });
    const r = verifyPush({ headers: headersFor("del_1", noMsg), rawBody: noMsg, secret: SECRET, nowSeconds: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it("handlePush dedupes a redelivery (202, no second store)", () => {
    const stored = [];
    const store = (id, env) => {
      stored.push(id);
      return { stored: true };
    };
    const args = { rawBody: BODY, secret: SECRET, nowSeconds: NOW, store };
    const first = handlePush({ ...args, headers: headersFor("del_9", BODY) });
    assert.equal(first.status, 202);
    assert.equal(stored.length, 1);
    // The mailbox itself dedupes; handlePush must not store twice
    // when the store reports a duplicate.
    const dupStore = () => ({ stored: false, duplicate: true });
    const second = handlePush({ ...args, store: dupStore, headers: headersFor("del_9", BODY) });
    assert.equal(second.status, 202);
    assert.equal(second.duplicate, true);
    assert.equal(stored.length, 1);
  });

  it("signPush matches the stub's formula (v1=hmac(ts.deliveryId.body))", () => {
    const expected = "v1=" + createHmac("sha256", SECRET).update(`${NOW}.del_1.${BODY}`).digest("hex");
    assert.equal(signPush(SECRET, String(NOW), "del_1", BODY), expected);
  });
});

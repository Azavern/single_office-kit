import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockOffice, TEST_TOKEN, TEST_SURROGATE, makeEnvelope } from "./helpers.js";
import { OfficeWs } from "../src/office-ws.js";

describe("office WS client (raw Engine.IO + Socket.IO)", () => {
  let mock;
  before(async () => {
    mock = await new MockOffice().listen();
  });
  after(async () => mock.close());

  it("connects with a valid token and receives deliveries", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_TOKEN, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    const deliveries = [];
    ws.on("delivery", (env) => deliveries.push(env));
    await ws.connect({ timeoutMs: 5000 });
    assert.equal(ws.connected, true);
    mock.pushDelivery(makeEnvelope({ deliveryId: "del_ws_1", body: "tes WS" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].deliveryId, "del_ws_1");
    assert.equal(deliveries[0].message.body, "tes WS");
    // The bare client does NOT auto-ack (the daemon acks after
    // filing). Ack explicitly here and check it reaches the office.
    ws.ackDelivery("del_ws_1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(mock.acks.length, 1);
    assert.equal(mock.acks[0].deliveryId, "del_ws_1");
    ws.disconnect();
  });

  it("real-token path is unchanged: token in the CONNECT packet, no header", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_TOKEN, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    await ws.connect({ timeoutMs: 5000 });
    assert.equal(ws.connected, true);
    const last = mock.connectAuth.at(-1);
    assert.equal(last.via, "packet");
    assert.equal(last.header, "");
    assert.ok(mock.connectPackets.at(-1).includes(`"token":"${TEST_TOKEN}"`));
    ws.disconnect();
  });

  it("surrogate token: header-only auth + empty CONNECT packet", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_SURROGATE, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    await ws.connect({ timeoutMs: 5000 });
    assert.equal(ws.connected, true);
    const last = mock.connectAuth.at(-1);
    assert.equal(last.via, "header");
    assert.equal(last.header, `Bearer ${TEST_SURROGATE}`);
    assert.equal(mock.connectPackets.at(-1), "0{}");
    ws.disconnect();
  });

  it("a surrogate in the CONNECT packet is refused (never send it there)", async () => {
    // A raw client that puts the surrogate in the packet must be
    // refused, exactly like the real gateway (the packet token wins
    // over the header, and a surrogate in a WS frame is unswapped).
    const { WebSocket } = await import("ws");
    const url = new URL(mock.baseUrl);
    url.protocol = "ws:";
    url.pathname = "/socket.io/";
    url.search = "?EIO=4&transport=websocket";
    const raw = new WebSocket(url.toString());
    const refused = await new Promise((resolve) => {
      raw.on("message", (data) => {
        const text = data.toString();
        if (text.startsWith("0{")) raw.send(`40${JSON.stringify({ token: TEST_SURROGATE })}`);
        if (text.startsWith("44")) resolve(true);
      });
      setTimeout(() => resolve(false), 3000);
    });
    assert.equal(refused, true);
    raw.close();
  });

  it("refuses a bad token with unauthorized (44) and keeps retrying", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => "soa_wrong", { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    let refused = null;
    ws.on("unauthorized", (detail) => {
      refused = detail;
    });
    await assert.rejects(() => ws.connect({ timeoutMs: 3000 }), /unauthorized/);
    assert.equal(refused, "unauthorized");
    assert.equal(ws.connected, false);
    ws.disconnect();
  });

  it("answers Engine.IO pings with pongs (mock records no error)", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_TOKEN, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    await ws.connect({ timeoutMs: 5000 });
    mock.sendPing();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ws.connected, true);
    ws.disconnect();
  });

  it("message.send returns the server ack", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_TOKEN, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    await ws.connect({ timeoutMs: 5000 });
    const res = await ws.sendMessage("room_main_1", { body: "balasan lewat WS" });
    assert.equal(res.ok, true);
    assert.equal(res.message.body, "balasan lewat WS");
    assert.equal(mock.receivedSends.length, 1);
    assert.equal(mock.receivedSends[0].roomId, "room_main_1");
    ws.disconnect();
  });

  it("joinRoom returns the join ack", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_TOKEN, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    await ws.connect({ timeoutMs: 5000 });
    const res = await ws.joinRoom("room_main_1");
    assert.equal(res.ok, true);
    assert.equal(res.channel, "room:room_main_1");
    assert.deepEqual(mock.joins, ["room:room_main_1"]);
    ws.disconnect();
  });

  it("reconnects after the server drops the connection", async () => {
    const ws = new OfficeWs(mock.baseUrl, async () => TEST_TOKEN, { reconnectBaseMs: 50, reconnectMaxMs: 200 });
    let connects = 0;
    ws.on("connect", () => connects++);
    await ws.connect({ timeoutMs: 5000 });
    assert.equal(connects, 1);
    // Drop every client socket at the mock: the client must come back.
    for (const client of mock.clients) client.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(connects >= 2, `expected a reconnect, saw ${connects} connects`);
    assert.equal(ws.connected, true);
    ws.disconnect();
  });
});

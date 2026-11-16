import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockOffice, TEST_TOKEN } from "./helpers.js";
import { OfficeRest, OfficeError } from "../src/office-rest.js";

describe("office REST client", () => {
  let mock;
  let rest;
  before(async () => {
    mock = await new MockOffice().listen();
    rest = new OfficeRest(mock.baseUrl, async () => TEST_TOKEN);
  });
  after(async () => mock.close());

  it("me() returns the agent identity", async () => {
    const me = await rest.me();
    assert.equal(me.id, "agent_test");
    assert.equal(me.name, "TestAgent");
    assert.deepEqual(me.scopes, ["rooms.create", "files.upload"]);
  });

  it("pushSecret() returns the agent's own push-signing secret", async () => {
    const secret = await rest.pushSecret();
    assert.equal(secret.push_secret, "office-push-secret");
  });

  it("REST requests carry a browser User-Agent (Cloudflare blocks the rest)", async () => {
    await rest.me();
    const call = mock.restCalls.filter((c) => c.path === "/api/v1/agent/me").at(-1);
    assert.ok(call.userAgent.startsWith("Mozilla/5.0"), `UA was: ${call.userAgent}`);
  });

  it("setName() renames, and the office refuses reserved names", async () => {
    const renamed = await rest.setName("TestAgent-Bot");
    assert.equal(renamed.name, "TestAgent-Bot");
    await assert.rejects(() => rest.setName("Ryn"), (err) => {
      assert.ok(err instanceof OfficeError);
      assert.equal(err.status, 403);
      return true;
    });
  });

  it("createRoom() creates the main room with Veo as participant", async () => {
    const room = await rest.createRoom({
      kind: "main",
      title: "TestAgent — Veo",
      participants: [
        { type: "user", id: "user_veo" },
        { type: "agent", id: "agent_test" },
      ],
    });
    assert.equal(room.id, "room_main_1");
    assert.equal(room.kind, "main");
  });

  it("createRoom() fails when fewer than two participants are given", async () => {
    await assert.rejects(() => rest.createRoom({ kind: "main", participants: [{ type: "agent", id: "agent_test" }] }), (err) => {
      assert.ok(err instanceof OfficeError);
      assert.equal(err.status, 400);
      return true;
    });
  });

  it("sendMessage() posts and listMessages() reads back", async () => {
    const sent = await rest.sendMessage("room_main_1", { body: "halo Veo", clientMsgId: "test-1" });
    assert.equal(sent.message.body, "halo Veo");
    const history = await rest.listMessages("room_main_1");
    assert.equal(history.room.id, "room_main_1");
    assert.deepEqual(history.messages, []);
  });

  it("setState() reports working", async () => {
    const presence = await rest.setState("working");
    assert.equal(presence.state, "working");
  });

  it("realtimeInfo() reports the office mode", async () => {
    const info = await rest.realtimeInfo();
    assert.equal(info.provider, "socketio");
  });

  it("a bad token surfaces as a 401 OfficeError", async () => {
    const bad = new OfficeRest(mock.baseUrl, async () => "soa_wrong");
    await assert.rejects(() => bad.me(), (err) => {
      assert.ok(err instanceof OfficeError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "unauthorized");
      return true;
    });
  });
});

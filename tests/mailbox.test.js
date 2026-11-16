import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox } from "../src/mailbox.js";

function tmpMailbox() {
  const dir = mkdtempSync(join(tmpdir(), "kit-mailbox-"));
  return {
    dir,
    mailbox: new Mailbox({ inboxDir: join(dir, "inbox"), readDir: join(dir, "read"), stateDir: join(dir, "state") }),
  };
}

describe("mailbox", () => {
  let dir;
  let mailbox;
  beforeEach(() => ({ dir, mailbox } = tmpMailbox()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores a delivery as one JSON file", () => {
    const r = mailbox.store("del_1", { deliveryId: "del_1", message: { body: "halo" } });
    assert.equal(r.stored, true);
    assert.ok(existsSync(join(dir, "inbox", "del_1.json")));
    assert.equal(mailbox.listPending().length, 1);
  });

  it("dedupes a redelivery (no second file, no second wake)", () => {
    mailbox.store("del_1", { deliveryId: "del_1" });
    const r = mailbox.store("del_1", { deliveryId: "del_1" });
    assert.equal(r.stored, false);
    assert.equal(r.duplicate, true);
    assert.equal(mailbox.listPending().length, 1);
  });

  it("remembers seen ids across restarts (seen.json)", () => {
    mailbox.store("del_1", { deliveryId: "del_1" });
    const again = new Mailbox({ inboxDir: join(dir, "inbox"), readDir: join(dir, "read"), stateDir: join(dir, "state") });
    assert.equal(again.hasSeen("del_1"), true);
    assert.equal(again.store("del_1", { deliveryId: "del_1" }).stored, false);
  });

  it("lists pending oldest first", () => {
    mailbox.store("del_b", { deliveryId: "del_b" });
    mailbox.store("del_a", { deliveryId: "del_a" });
    const pending = mailbox.listPending();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].delivery_id, "del_b");
  });

  it("markRead moves the file out of inbox/", () => {
    mailbox.store("del_1", { deliveryId: "del_1" });
    assert.equal(mailbox.markRead("del_1"), true);
    assert.equal(mailbox.listPending().length, 0);
    assert.ok(existsSync(join(dir, "read", "del_1.json")));
    assert.equal(mailbox.markRead("del_1"), false);
  });

  it("rejects a store without a delivery id", () => {
    assert.throws(() => mailbox.store("", {}), /delivery id/);
  });

  it("survives a corrupt seen.json (starts empty)", () => {
    const stateDir = join(dir, "state");
    mailbox.store("del_1", { deliveryId: "del_1" });
    writeFileSync(join(stateDir, "seen.json"), "{corrupt", "utf8");
    const again = new Mailbox({ inboxDir: join(dir, "inbox"), readDir: join(dir, "read"), stateDir });
    assert.equal(again.hasSeen("del_1"), false);
  });
});

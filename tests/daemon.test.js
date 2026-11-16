import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockOffice, TEST_TOKEN, makeEnvelope } from "./helpers.js";
import { AgentDaemon } from "../src/daemon.js";
import { signPush } from "../src/push.js";
import { ConfigError } from "../src/config.js";

const PUSH_SECRET = "test-push-secret";

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("daemon (mock office end-to-end)", () => {
  let mock;
  let dir;
  let daemon;
  const LOCAL_PORT = 18789;

  before(async () => {
    mock = await new MockOffice().listen();
    dir = mkdtempSync(join(tmpdir(), "kit-daemon-"));
    const config = {
      baseUrl: mock.baseUrl,
      localPort: LOCAL_PORT,
      agentName: "test-agent",
      serviceName: "test-agent-side",
      kitDir: dir,
      inboxDir: join(dir, "inbox"),
      readDir: join(dir, "read"),
      stateDir: join(dir, "state"),
      pushSkewSeconds: 300,
      wsReconnectBaseMs: 50,
      wsReconnectMaxMs: 200,
    };
    daemon = new AgentDaemon(config, {
      getToken: async () => TEST_TOKEN,
      getPushSecret: async () => PUSH_SECRET,
    });
    await daemon.start();
    await waitFor(() => daemon.ws.connected, 5000);
  });

  after(async () => {
    daemon.ws.disconnect();
    try {
      daemon.http.close();
    } catch {}
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("health reports connected + pending count", async () => {
    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`);
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.ok, true);
    assert.equal(health.wsConnected, true);
    assert.equal(health.mode, "ws-outbound");
  });

  it("a WS delivery is filed in the mailbox and acked (mock handshake)", async () => {
    const envelope = makeEnvelope({ deliveryId: "del_daemon_1", body: "halo dari mock office" });
    mock.pushDelivery(envelope);
    await waitFor(() => daemon.mailbox.listPending().length === 1, 5000);
    const pending = daemon.mailbox.listPending();
    assert.equal(pending[0].delivery_id, "del_daemon_1");
    assert.equal(pending[0].envelope.message.body, "halo dari mock office");
    await waitFor(() => mock.acks.length === 1, 5000);
    assert.equal(mock.acks[0].deliveryId, "del_daemon_1");
  });

  it("a WS redelivery is acked but not filed twice", async () => {
    const envelope = makeEnvelope({ deliveryId: "del_daemon_1", body: "halo dari mock office" });
    mock.pushDelivery(envelope);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(daemon.mailbox.listPending().length, 1);
    await waitFor(() => mock.acks.length === 2, 5000);
  });

  it("a signed POST /push is filed (202), a bad signature is refused (401)", async () => {
    const envelope = makeEnvelope({ deliveryId: "del_push_1", body: "lewat push" });
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signPush(PUSH_SECRET, ts, "del_push_1", rawBody);
    const ok = await fetch(`http://127.0.0.1:${LOCAL_PORT}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Office-Delivery": "del_push_1",
        "X-Office-Timestamp": ts,
        "X-Office-Signature": sig,
      },
      body: rawBody,
    });
    assert.equal(ok.status, 202);
    await waitFor(() => daemon.mailbox.listPending().length === 2, 5000);
    const bad = await fetch(`http://127.0.0.1:${LOCAL_PORT}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Office-Delivery": "del_push_2",
        "X-Office-Timestamp": ts,
        "X-Office-Signature": "v1=wrong",
      },
      body: rawBody,
    });
    assert.equal(bad.status, 401);
    assert.equal(daemon.mailbox.listPending().length, 2);
  });

  it("GET /inbox lists the pending deliveries", async () => {
    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/inbox`);
    assert.equal(res.status, 200);
    const { pending } = await res.json();
    assert.equal(pending.length, 2);
    assert.deepEqual(
      pending.map((p) => p.delivery_id).sort(),
      ["del_daemon_1", "del_push_1"],
    );
  });
});

describe("daemon push secret from the office (no restart on rotation)", () => {
  // The daemon is built WITHOUT a getPushSecret override, so the
  // default path runs: env → file → office (fresh per POST /push) →
  // vault (fail-closed). The mock office's push secret is the source
  // of truth; rotating it must be picked up with no restart.
  let mock;
  let dir;
  let daemon;
  const LOCAL_PORT = 18791;

  before(async () => {
    mock = await new MockOffice().listen();
    dir = mkdtempSync(join(tmpdir(), "kit-daemon-office-push-"));
    const config = {
      baseUrl: mock.baseUrl,
      localPort: LOCAL_PORT,
      agentName: "test-agent",
      serviceName: "test-agent-side",
      kitDir: dir,
      inboxDir: join(dir, "inbox"),
      readDir: join(dir, "read"),
      stateDir: join(dir, "state"),
      pushSkewSeconds: 300,
      wsReconnectBaseMs: 50,
      wsReconnectMaxMs: 200,
    };
    daemon = new AgentDaemon(config, {
      getToken: async () => TEST_TOKEN,
      // No getPushSecret override — and no env/file secret, so the
      // office is the only source. OFFICE_PUSH_SECRET_FILE points
      // at a missing path to keep the test hermetic.
      env: { OFFICE_PUSH_SECRET_FILE: join(dir, "missing-secret") },
    });
    await daemon.start();
    await waitFor(() => daemon.ws.connected, 5000);
  });

  after(async () => {
    daemon.ws.disconnect();
    try {
      daemon.http.close();
    } catch {}
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function postPush(deliveryId, secret, body) {
    const rawBody = JSON.stringify(body ?? makeEnvelope({ deliveryId, body: "lewat push office" }));
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(`http://127.0.0.1:${LOCAL_PORT}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Office-Delivery": deliveryId,
        "X-Office-Timestamp": ts,
        "X-Office-Signature": signPush(secret, ts, deliveryId, rawBody),
      },
      body: rawBody,
    });
  }

  it("a push signed with the office-fetched secret is filed (202), a bad signature is refused (401)", async () => {
    const ok = await postPush("del_office_1", "office-push-secret");
    assert.equal(ok.status, 202);
    await waitFor(() => daemon.mailbox.listPending().length === 1, 5000);
    const bad = await postPush("del_office_2", "wrong-secret");
    assert.equal(bad.status, 401);
    assert.equal(daemon.mailbox.listPending().length, 1);
  });

  it("a rotation in the office is picked up with no restart", async () => {
    mock.pushSecret = "office-secret-v2";
    const ok = await postPush("del_office_3", "office-secret-v2");
    assert.equal(ok.status, 202);
    await waitFor(() => daemon.mailbox.listPending().length === 2, 5000);
    // The old secret no longer verifies.
    const stale = await postPush("del_office_4", "office-push-secret");
    assert.equal(stale.status, 401);
    assert.equal(daemon.mailbox.listPending().length, 2);
  });

  it("no secret set in the office answers 503 and files nothing", async () => {
    mock.pushSecret = null;
    const res = await postPush("del_office_5", "office-secret-v2");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "not_configured");
    assert.equal(daemon.mailbox.listPending().length, 2);
  });
});

describe("daemon push secret vault-only (fail closed)", () => {
  // The vault holds the secret but a surrogate cannot verify HMACs,
  // so the daemon must answer 503 not_configured — never 401, which
  // would wrongly blame the office's signature.
  let mock;
  let dir;
  let daemon;
  const LOCAL_PORT = 18790;

  before(async () => {
    mock = await new MockOffice().listen();
    dir = mkdtempSync(join(tmpdir(), "kit-daemon-push-"));
    const config = {
      baseUrl: mock.baseUrl,
      localPort: LOCAL_PORT,
      agentName: "test-agent",
      serviceName: "test-agent-side",
      kitDir: dir,
      inboxDir: join(dir, "inbox"),
      readDir: join(dir, "read"),
      stateDir: join(dir, "state"),
      pushSkewSeconds: 300,
      wsReconnectBaseMs: 50,
      wsReconnectMaxMs: 200,
    };
    daemon = new AgentDaemon(config, {
      getToken: async () => TEST_TOKEN,
      getPushSecret: async () => {
        throw new ConfigError(
          "Push secret is stored in the Secure Vault (custom.single-office-push) " +
          "but a vault surrogate cannot verify push HMACs.",
        );
      },
    });
    await daemon.start();
  });

  after(async () => {
    daemon.ws.disconnect();
    try {
      daemon.http.close();
    } catch {}
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a push with no usable secret answers 503 and files nothing", async () => {
    const envelope = makeEnvelope({ deliveryId: "del_push_vault", body: "lewat push" });
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Office-Delivery": "del_push_vault",
        "X-Office-Timestamp": ts,
        // Signed with the real (dummy) secret — the daemon has no
        // usable key, so the failure must be 503, not 401.
        "X-Office-Signature": signPush(PUSH_SECRET, ts, "del_push_vault", rawBody),
      },
      body: rawBody,
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "not_configured");
    assert.equal(daemon.mailbox.listPending().length, 0);
  });
});

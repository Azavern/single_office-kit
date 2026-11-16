import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEST_PORT = 15353;
const FORWARDER = new URL("../tunnel/dns-forwarder.py", import.meta.url).pathname;

// NOTE: this VM blocks unconnected UDP sends (sendto -> EPERM) for
// Node/Python/C, so the tests drive the forwarder with `dig` (a system
// binary whose UDP works) instead of Node's dgram. See dns-forwarder.py.
async function dig(port, qname, qtype) {
  const { stdout } = await execFileAsync("dig", [
    `@127.0.0.1`, "-p", String(port), qname, qtype, "+noall", "+answer", "+comments",
  ], { timeout: 10000 });
  return stdout;
}

// Answer lines only (dig +comments also prints ";;" comment lines).
function answerLines(out) {
  return out.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith(";;"));
}

describe("tunnel dns-forwarder", () => {
  let dir;
  let child;
  let childOut = "";

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "kit-dns-"));
    child = spawn("python3", [FORWARDER, "--host", "127.0.0.1", "--port", String(TEST_PORT),
      "--pid-file", join(dir, "forwarder.pid")], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => { childOut += c.toString(); });
    child.stderr.on("data", (c) => { childOut += c.toString(); });
    // Wait until it answers (max 10s).
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        const out = await dig(TEST_PORT, "_v2-origintunneld._tcp.argotunnel.com", "SRV");
        if (out.includes("region1.v2.argotunnel.com")) break;
        throw new Error("no SRV answer yet");
      } catch (e) {
        if (Date.now() > deadline) throw new Error("forwarder did not start: " + childOut + " / " + e.message);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("answers the v2 SRV with region1 (priority 1) + region2 (priority 2) on port 7844", async () => {
    const out = await dig(TEST_PORT, "_v2-origintunneld._tcp.argotunnel.com", "SRV");
    const lines = answerLines(out);
    assert.equal(lines.length, 2);
    // "<name> <ttl> IN SRV <priority> <weight> <port> <target>"
    const fields = lines.map((l) => l.split(/\s+/));
    assert.equal(fields[0][4], "1"); // priority
    assert.equal(fields[0][6], "7844"); // port
    assert.equal(fields[0][7], "region1.v2.argotunnel.com.");
    assert.equal(fields[1][4], "2"); // priority
    assert.equal(fields[1][6], "7844");
    assert.equal(fields[1][7], "region2.v2.argotunnel.com.");
  });

  it("answers the v1 SRV the same way (region1/region2.argotunnel.com)", async () => {
    const out = await dig(TEST_PORT, "_origintunneld._tcp.argotunnel.com", "SRV");
    const lines = answerLines(out);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes("region1.argotunnel.com."));
    assert.ok(lines[1].includes("region2.argotunnel.com."));
  });

  it("forwards other queries to the system resolver (office A record)", async () => {
    const out = await dig(TEST_PORT, "office.sailox.my.id", "A");
    const lines = answerLines(out);
    assert.ok(lines.length >= 1);
    assert.ok(/\sIN\s+A\s/.test(lines[0]), lines[0]);
  });

  it("forwards A queries for the edge hosts (system resolver answers them)", async () => {
    const out = await dig(TEST_PORT, "region1.v2.argotunnel.com", "A");
    const lines = answerLines(out);
    assert.ok(lines.length >= 1);
    assert.ok(/\sIN\s+A\s/.test(lines[0]), lines[0]);
  });

  it("returns SERVFAIL (never hangs) when the upstream is unreachable", async () => {
    // A second forwarder pointing at a dead upstream (nothing on 127.0.0.1:53).
    const dir2 = mkdtempSync(join(tmpdir(), "kit-dns-dead-"));
    const dead = spawn("python3", [FORWARDER, "--host", "127.0.0.1", "--port", "15354",
      "--upstream", "127.0.0.1", "--upstream2", "", "--pid-file", join(dir2, "f.pid")],
      { stdio: "ignore" });
    try {
      // Wait for the dead-upstream forwarder to bind (it answers
      // SERVFAIL after its ~5s upstream timeout, so allow 25s).
      let stdout = "";
      const deadline = Date.now() + 25000;
      for (;;) {
        try {
          ({ stdout } = await execFileAsync("dig", [
            "@127.0.0.1", "-p", "15354", "example.com", "A", "+noall", "+comments",
          ], { timeout: 20000 }));
          break;
        } catch (e) {
          if (Date.now() > deadline) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      assert.ok(stdout.includes("status: SERVFAIL"), stdout);
    } finally {
      dead.kill("SIGTERM");
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

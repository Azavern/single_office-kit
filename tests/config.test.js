import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken, loadPushSecret, loadConfig, ConfigError, defaultTokenFile, defaultPushSecretFile, agentName } from "../src/config.js";

const AGENT_ENV = { OFFICE_AGENT_NAME: "finch" };

describe("config", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads the token from env", () => {
    assert.equal(loadToken({ ...AGENT_ENV, OFFICE_AGENT_TOKEN: "soa_test123" }), "soa_test123");
  });

  it("loads the token from a file", () => {
    const file = join(dir, "token");
    writeFileSync(file, "soa_fromfile\n", "utf8");
    chmodSync(file, 0o600);
    assert.equal(loadToken({ ...AGENT_ENV, OFFICE_TOKEN_FILE: file }), "soa_fromfile");
  });

  it("env wins over the file", () => {
    const file = join(dir, "token");
    writeFileSync(file, "soa_fromfile", "utf8");
    assert.equal(loadToken({ ...AGENT_ENV, OFFICE_AGENT_TOKEN: "soa_fromenv", OFFICE_TOKEN_FILE: file }), "soa_fromenv");
  });

  it("fails fast with a clear message when there is no token", () => {
    assert.throws(() => loadToken({ ...AGENT_ENV, OFFICE_TOKEN_FILE: join(dir, "missing") }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /No office token/);
      assert.match(err.message, /Secure Vault/);
      return true;
    });
  });

  it("refuses an empty token file", () => {
    const file = join(dir, "token");
    writeFileSync(file, "   \n", "utf8");
    assert.throws(() => loadToken({ ...AGENT_ENV, OFFICE_TOKEN_FILE: file }), /empty/);
  });

  it("refuses a token file with whitespace inside", () => {
    const file = join(dir, "token");
    writeFileSync(file, "soa_abc def", "utf8");
    assert.throws(() => loadToken({ ...AGENT_ENV, OFFICE_TOKEN_FILE: file }), /single token/);
  });

  it("loadPushSecret returns null when nothing is configured", () => {
    assert.equal(loadPushSecret({ ...AGENT_ENV, OFFICE_PUSH_SECRET_FILE: join(dir, "missing") }), null);
  });

  it("loadPushSecret reads env first", () => {
    assert.equal(loadPushSecret({ ...AGENT_ENV, OFFICE_PUSH_SECRET: "push-secret" }), "push-secret");
  });

  it("agentName is required and normalized to a lowercase slug", () => {
    assert.equal(agentName({ OFFICE_AGENT_NAME: "Finch" }), "finch");
    assert.equal(agentName({ OFFICE_AGENT_NAME: "  finch-bot " }), "finch-bot");
    assert.throws(() => agentName({}), /OFFICE_AGENT_NAME/);
    assert.throws(() => agentName({ OFFICE_AGENT_NAME: "Finch Bot" }), /OFFICE_AGENT_NAME/);
    assert.throws(() => agentName({ OFFICE_AGENT_NAME: "1abc" }), /OFFICE_AGENT_NAME/);
  });

  it("default token and push-secret files derive from the agent name", () => {
    assert.match(defaultTokenFile({ OFFICE_AGENT_NAME: "finch" }), /\.config\/single-office\/finch-token$/);
    assert.match(defaultPushSecretFile({ OFFICE_AGENT_NAME: "finch" }), /\.config\/single-office\/finch-push-secret$/);
    assert.match(defaultTokenFile({ OFFICE_AGENT_NAME: "eriri" }), /\.config\/single-office\/eriri-token$/);
  });

  it("loadConfig defaults to the live office and port 8789, with the agent name", () => {
    const cfg = loadConfig({ OFFICE_AGENT_NAME: "finch" });
    assert.equal(cfg.baseUrl, "https://office.sailox.my.id");
    assert.equal(cfg.localPort, 8789);
    assert.equal(cfg.agentName, "finch");
    assert.equal(cfg.serviceName, "finch-side");
    assert.equal(cfg.pushSkewSeconds, 300);
  });

  it("loadConfig rejects a bad base URL, a bad port, and a missing agent name", () => {
    assert.throws(() => loadConfig({ OFFICE_AGENT_NAME: "finch", OFFICE_BASE_URL: "not a url" }), /valid URL/);
    assert.throws(() => loadConfig({ OFFICE_AGENT_NAME: "finch", AGENT_LOCAL_PORT: "abc" }), /port number/);
    assert.throws(() => loadConfig({}), /OFFICE_AGENT_NAME/);
  });

  it("loadConfig honours AGENT_LOCAL_PORT and AGENT_KIT_DIR", () => {
    const cfg = loadConfig({ OFFICE_AGENT_NAME: "finch", AGENT_LOCAL_PORT: "18789", AGENT_KIT_DIR: dir });
    assert.equal(cfg.localPort, 18789);
    assert.equal(cfg.kitDir, dir);
    assert.equal(cfg.inboxDir, join(dir, "inbox"));
    assert.equal(cfg.stateDir, join(dir, "state"));
  });
});

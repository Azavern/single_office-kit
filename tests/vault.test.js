import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveToken,
  tokenSource,
  isSurrogate,
  resolvePushSecret,
  resolvePushSecretViaOffice,
  getVaultPushSecretSurrogate,
  VAULT_PUSH_CREDENTIAL,
} from "../src/vault.js";
import { ConfigError } from "../src/config.js";

describe("vault push-secret resolution", () => {
  // Dummy values only — never a real secret. The mock surrogate is a
  // placeholder string, exactly the shape authd returns.
  const MOCK_SURROGATE = "hsurr:mock-push-secret";

  it("push credential id is distinct from the token credential", () => {
    assert.equal(VAULT_PUSH_CREDENTIAL, "custom.single-office-push");
    assert.notEqual(VAULT_PUSH_CREDENTIAL, "custom.single-office");
  });

  it("getVaultPushSecretSurrogate returns the trimmed surrogate from the helper", () => {
    const out = getVaultPushSecretSurrogate(() => `${MOCK_SURROGATE}\n`);
    assert.equal(out, MOCK_SURROGATE);
  });

  it("getVaultPushSecretSurrogate rejects a non-surrogate value", () => {
    assert.throws(
      () => getVaultPushSecretSurrogate(() => "not-a-surrogate\n"),
      (err) => err instanceof ConfigError && /non-surrogate/.test(err.message),
    );
  });

  it("getVaultPushSecretSurrogate wraps a helper failure", () => {
    const boom = new Error("spawn ENOENT");
    boom.stderr = "get-push-secret-surrogate: authd unreachable\n";
    assert.throws(
      () => getVaultPushSecretSurrogate(() => { throw boom; }),
      (err) => err instanceof ConfigError && /cannot obtain a push secret surrogate/.test(err.message),
    );
  });

  it("resolvePushSecret prefers env over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-push-"));
    try {
      const file = join(dir, "test-push-secret");
      writeFileSync(file, "push-from-file", "utf8");
      let vaultCalled = false;
      const fetchSurrogate = () => { vaultCalled = true; return MOCK_SURROGATE; };
      assert.equal(
        resolvePushSecret({ OFFICE_PUSH_SECRET: "push-from-env", OFFICE_PUSH_SECRET_FILE: file }, { fetchSurrogate }),
        "push-from-env",
      );
      assert.equal(vaultCalled, false);
      assert.equal(
        resolvePushSecret({ OFFICE_PUSH_SECRET_FILE: file }, { fetchSurrogate }),
        "push-from-file",
      );
      assert.equal(vaultCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolvePushSecret fails fast on a malformed file and never consults the vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-push-"));
    try {
      const file = join(dir, "test-push-secret");
      writeFileSync(file, "has whitespace inside", "utf8");
      let vaultCalled = false;
      const fetchSurrogate = () => { vaultCalled = true; return MOCK_SURROGATE; };
      assert.throws(
        () => resolvePushSecret({ OFFICE_PUSH_SECRET_FILE: file }, { fetchSurrogate }),
        (err) => err instanceof ConfigError && /single token/.test(err.message),
      );
      assert.equal(vaultCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolvePushSecret vault-only fails closed and never returns the surrogate", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-push-"));
    try {
      let vaultCalled = false;
      const fetchSurrogate = () => { vaultCalled = true; return MOCK_SURROGATE; };
      assert.throws(
        () => resolvePushSecret({ OFFICE_PUSH_SECRET_FILE: join(dir, "missing") }, { fetchSurrogate }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, /surrogate cannot verify push HMACs/);
          assert.match(err.message, /custom\.single-office-push/);
          // The thrown message must never carry the surrogate value.
          assert.doesNotMatch(err.message, /hsurr:/);
          return true;
        },
      );
      assert.equal(vaultCalled, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolvePushSecret surfaces a vault fetch failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-push-"));
    try {
      const fetchSurrogate = () => {
        throw new ConfigError("cannot obtain a push secret surrogate from the vault: boom");
      };
      assert.throws(
        () => resolvePushSecret({ OFFICE_PUSH_SECRET_FILE: join(dir, "missing") }, { fetchSurrogate }),
        (err) => err instanceof ConfigError && /cannot obtain a push secret surrogate/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vault push-secret resolution via the office", () => {
  // The office fetch is the delivery channel the vault cannot be:
  // the value arrives over authenticated REST, so it is a real key.
  // Dummy values only — never a real secret or surrogate.
  const MOCK_SURROGATE = "hsurr:mock-push-secret";
  const OFFICE_SECRET = "office-fetched-secret";

  function missingEnv() {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-office-"));
    return { dir, env: { OFFICE_PUSH_SECRET_FILE: join(dir, "missing") } };
  }

  it("office-fetched secret is used and the vault is never consulted", async () => {
    const { dir, env } = missingEnv();
    try {
      let vaultCalled = false;
      let officeCalled = false;
      const rest = {
        pushSecret: async () => {
          officeCalled = true;
          return { push_secret: OFFICE_SECRET };
        },
      };
      const fetchSurrogate = () => { vaultCalled = true; return MOCK_SURROGATE; };
      assert.equal(
        await resolvePushSecretViaOffice(env, rest, { fetchSurrogate }),
        OFFICE_SECRET,
      );
      assert.equal(officeCalled, true);
      assert.equal(vaultCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env still wins over the office", async () => {
    const { dir, env } = missingEnv();
    try {
      let officeCalled = false;
      const rest = {
        pushSecret: async () => {
          officeCalled = true;
          return { push_secret: OFFICE_SECRET };
        },
      };
      assert.equal(
        await resolvePushSecretViaOffice(
          { ...env, OFFICE_PUSH_SECRET: "push-from-env" },
          rest,
        ),
        "push-from-env",
      );
      assert.equal(officeCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("office returning null falls through to the vault fail-closed path", async () => {
    const { dir, env } = missingEnv();
    try {
      let vaultCalled = false;
      const rest = { pushSecret: async () => ({ push_secret: null }) };
      const fetchSurrogate = () => { vaultCalled = true; return MOCK_SURROGATE; };
      await assert.rejects(
        () => resolvePushSecretViaOffice(env, rest, { fetchSurrogate }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, /surrogate cannot verify push HMACs/);
          assert.doesNotMatch(err.message, /hsurr:/);
          return true;
        },
      );
      assert.equal(vaultCalled, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed office fetch falls through to the vault fail-closed path", async () => {
    const { dir, env } = missingEnv();
    try {
      let vaultCalled = false;
      const rest = {
        pushSecret: async () => {
          throw new Error("office unreachable");
        },
      };
      const fetchSurrogate = () => { vaultCalled = true; return MOCK_SURROGATE; };
      await assert.rejects(
        () => resolvePushSecretViaOffice(env, rest, { fetchSurrogate }),
        (err) => err instanceof ConfigError && /surrogate cannot verify push HMACs/.test(err.message),
      );
      assert.equal(vaultCalled, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty office secret is treated as unset", async () => {
    const { dir, env } = missingEnv();
    try {
      const rest = { pushSecret: async () => ({ push_secret: "" }) };
      const fetchSurrogate = () => MOCK_SURROGATE;
      await assert.rejects(
        () => resolvePushSecretViaOffice(env, rest, { fetchSurrogate }),
        (err) => err instanceof ConfigError && /surrogate cannot verify push HMACs/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vault token resolution", () => {
  it("isSurrogate only matches hsurr: tokens", () => {
    assert.equal(isSurrogate("hsurr:abc"), true);
    assert.equal(isSurrogate("soa_real_token"), false);
    assert.equal(isSurrogate(""), false);
    assert.equal(isSurrogate(null), false);
  });

  it("tokenSource reports env, file, or vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-"));
    try {
      const missing = join(dir, "no-token");
      assert.equal(tokenSource({ OFFICE_AGENT_TOKEN: "soa_x", OFFICE_TOKEN_FILE: missing }), "env");
      assert.equal(tokenSource({ OFFICE_TOKEN_FILE: missing }), "vault");
      const file = join(dir, "test-token");
      writeFileSync(file, "soa_from_file", "utf8");
      assert.equal(tokenSource({ OFFICE_TOKEN_FILE: file }), "file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveToken prefers env over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-"));
    try {
      const file = join(dir, "test-token");
      writeFileSync(file, "soa_from_file", "utf8");
      assert.equal(
        resolveToken({ OFFICE_AGENT_TOKEN: "soa_from_env", OFFICE_TOKEN_FILE: file }),
        "soa_from_env",
      );
      assert.equal(resolveToken({ OFFICE_TOKEN_FILE: file }), "soa_from_file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

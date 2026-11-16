#!/usr/bin/env python3
"""Print one fresh Single Office push-secret surrogate (hsurr:...) to stdout.

Reads the registered custom.single-office-push credential from authd via
dynamic_credentials. Prints ONLY the surrogate string, nothing else.
The surrogate is a placeholder, not the real secret: never log it,
never paste it anywhere, never pass it as a command-line argument.
Exit non-zero with the failure on stderr when authd cannot provide one.

IMPORTANT — what a surrogate can and cannot do: the daemon verifies
§8.4 push HMACs LOCALLY (src/push.js computes HMAC-SHA256 in-process),
and Sentinel swaps a surrogate for the real value only on an approved
outbound request to a registered host. A push secret is never sent
anywhere, so a surrogate can NEVER serve as the HMAC key. The daemon
fetches the surrogate only to prove the secret is stored in the vault;
if no real secret is configured (env/file), it fails closed with 503
"not_configured" instead of using the surrogate and failing every
push with 401. See src/vault.js resolvePushSecret and RUNBOOK.md §9.
"""
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import DynamicCredentialError, dynamic_credential_entry


def main():
    try:
        entry = dynamic_credential_entry("custom.single-office-push")
    except DynamicCredentialError as exc:
        print(f"get-push-secret-surrogate: {exc}", file=sys.stderr)
        return 1
    surrogate = str(entry.get("surrogate", "")).strip()
    if not surrogate.startswith("hsurr:"):
        print("get-push-secret-surrogate: authd returned a non-surrogate value", file=sys.stderr)
        return 1
    sys.stdout.write(surrogate + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Print one fresh Single Office surrogate token (hsurr:...) to stdout.

Reads the registered custom.single-office credential from authd via
dynamic_credentials. Prints ONLY the surrogate string, nothing else.
The surrogate is a placeholder, not the real credential: never log it,
never paste it anywhere, never pass it as a command-line argument.
Exit non-zero with the failure on stderr when authd cannot provide one.
"""
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import DynamicCredentialError, dynamic_credential_entry


def main():
    try:
        entry = dynamic_credential_entry("custom.single-office")
    except DynamicCredentialError as exc:
        print(f"get-surrogate: {exc}", file=sys.stderr)
        return 1
    surrogate = str(entry.get("surrogate", "")).strip()
    if not surrogate.startswith("hsurr:"):
        print("get-surrogate: authd returned a non-surrogate value", file=sys.stderr)
        return 1
    sys.stdout.write(surrogate + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

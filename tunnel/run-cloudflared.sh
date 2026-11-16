#!/usr/bin/env bash
# run-cloudflared.sh — start cloudflared for one agent's tunnel.
# Usage: run-cloudflared.sh <agent> [config-file]
#   <agent>       e.g. finch  (hostname <agent>.sailox.my.id)
#   [config-file] default tunnel/<agent>.config.yml (from config.yml template)
#
# What it does, in order:
#   1. Ensures the DNS forwarder is running (starts it with setsid --fork
#      if its SRV check fails). cloudflared cannot discover its edge
#      without it — the VM's resolver REFUSEs the SRV lookup.
#   2. Runs cloudflared in a PRIVATE mount namespace whose /etc/resolv.conf
#      is over-mounted to point at the forwarder (127.0.0.1). The VM's
#      global /etc/resolv.conf is bind-mounted read-only and is NEVER
#      changed — only cloudflared's view of it changes, so a forwarder
#      failure can only break cloudflared, never the VM's DNS.
#   3. cloudflared reads the tunnel id + credentials from the config
#      file (credentials file mode 600, from the Secure Vault).
#
# The tunnel token / credentials file is NEVER printed here. If the
# config or credentials are missing, this script fails fast with a
# clear message instead of starting a broken tunnel.
set -euo pipefail

TUNNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_KIT_DIR="$(cd "$TUNNEL_DIR/.." && pwd)"  # kit root (unused by this script; kept for reference)
AGENT="${1:-}"
CONFIG="${2:-$TUNNEL_DIR/$AGENT.config.yml}"
FORWARDER_PID_FILE="$TUNNEL_DIR/state/forwarder.pid"
FORWARDER_LOG="$TUNNEL_DIR/state/forwarder.log"
RESOLV_CONF="$TUNNEL_DIR/resolv.conf"

if [ -z "$AGENT" ]; then
  echo "usage: run-cloudflared.sh <agent> [config-file]" >&2
  exit 2
fi
if [ ! -f "$CONFIG" ]; then
  echo "missing tunnel config: $CONFIG (run tunnel/setup.sh $AGENT first)" >&2
  exit 2
fi
if ! grep -q "^tunnel: [0-9a-f-]\{36\}$" "$CONFIG"; then
  echo "config $CONFIG has no real tunnel id yet (still a <TUNNEL_ID> placeholder?)" >&2
  echo "Ask Veo to create the named tunnel and give you its id + token (see tunnel/WHAT-TO-ASK-VEO.md)." >&2
  exit 2
fi
if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x "$HOME/tools/cloudflared/cloudflared" ]; then
  echo "cloudflared not found (expected ~/tools/cloudflared/cloudflared). Run tunnel/setup.sh $AGENT first." >&2
  exit 2
fi
CLOUDFLARED="${CLOUDFLARED:-$HOME/tools/cloudflared/cloudflared}"
command -v cloudflared >/dev/null 2>&1 && CLOUDFLARED="$(command -v cloudflared)"

# --- 1. DNS forwarder up? (SRV check; start it if not) ---
forwarder_ok() {
  dig @127.0.0.1 SRV _v2-origintunneld._tcp.argotunnel.com +short +time=2 +tries=1 2>/dev/null | grep -q "region1.v2.argotunnel.com"
}
if ! forwarder_ok; then
  echo "starting DNS forwarder..."
  mkdir -p "$TUNNEL_DIR/state"
  (setsid --fork python3 "$TUNNEL_DIR/dns-forwarder.py" --host 127.0.0.1 --port 53 \
    --pid-file "$FORWARDER_PID_FILE" >> "$FORWARDER_LOG" 2>&1 < /dev/null)
  for _ in $(seq 1 10); do
    forwarder_ok && break
    sleep 1
  done
  forwarder_ok || { echo "DNS forwarder did not come up — see $FORWARDER_LOG" >&2; exit 1; }
fi

# --- 2. resolv.conf for the namespace (nameserver 127.0.0.1) ---
printf 'nameserver 127.0.0.1\noptions edns0 trust-ad\n' > "$RESOLV_CONF"

# --- 3. cloudflared in a private mount namespace ---
# unshare --mount gives cloudflared its own mount table; the bind mount
# only affects this process tree. The namespace dies with cloudflared.
exec unshare --mount sh -c \
  'mount --bind "$0" /etc/resolv.conf && exec "$1" tunnel run --config "$2"' \
  "$RESOLV_CONF" "$CLOUDFLARED" "$CONFIG"

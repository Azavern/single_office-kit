#!/usr/bin/env bash
# setup.sh — install/verify the Single Office tunnel kit for one agent.
# Usage: setup.sh <agent> [--tunnel-id UUID] [--creds-file PATH]
#   <agent>        e.g. finch  (public hostname <agent>.sailox.my.id)
#   --tunnel-id    the named tunnel's UUID (from Veo's Cloudflare dashboard).
#                  Omit it to install everything EXCEPT the live tunnel —
#                  the config is written with a <TUNNEL_ID> placeholder and
#                  run-cloudflared.sh will refuse to start until it is filled.
#   --creds-file   tunnel credentials JSON (mode 600). Default:
#                  ~/.config/single-office/<agent>-tunnel.json
#
# What it does:
#   Phase 1 (no Veo input needed) — verifies cloudflared, writes
#     tunnel/<agent>.config.yml from the template, writes
#     tunnel/resolv.conf (nameserver 127.0.0.1, for the namespace),
#     verifies the DNS forwarder answers SRV + forwards (starts it
#     if needed), copies the watchdog hook script into ~/hooks/scripts/
#     WITHOUT registering it, and prints the WHAT-TO-ASK-VEO list.
#   Phase 2 (needs Veo) — fill in the tunnel id + credentials file,
#     then run the bogus-token transport test (see SETUP-GUIDE.md §5)
#     and, only when it passes, register the watchdog hook and go live.
#
# This script NEVER touches the VPS, the office repo, or /etc/resolv.conf
# (the global one is read-only here; only a private mount namespace
# over-mounts it for cloudflared). It never prints a token.
set -euo pipefail

TUNNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${1:-}"
shift || true
TUNNEL_ID=""
CREDS_FILE="$HOME/.config/single-office/${AGENT}-tunnel.json"
while [ $# -gt 0 ]; do
  case "$1" in
    --tunnel-id) TUNNEL_ID="$2"; shift 2 ;;
    --creds-file) CREDS_FILE="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$AGENT" ]; then
  echo "usage: setup.sh <agent> [--tunnel-id UUID] [--creds-file PATH]" >&2
  exit 2
fi
case "$AGENT" in
  *[!a-z0-9-]*) echo "agent name must be lowercase letters/digits/hyphen" >&2; exit 2 ;;
esac

echo "== Single Office tunnel kit — agent: $AGENT (host $AGENT.sailox.my.id) =="

# --- cloudflared ---
CLOUDFLARED="$HOME/tools/cloudflared/cloudflared"
if command -v cloudflared >/dev/null 2>&1; then CLOUDFLARED="$(command -v cloudflared)"; fi
if [ ! -x "$CLOUDFLARED" ]; then
  echo "cloudflared not found. Install it (see SETUP-GUIDE.md §2):" >&2
  echo "  mkdir -p ~/tools/cloudflared && cd ~/tools/cloudflared" >&2
  echo "  curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared" >&2
  exit 1
fi
echo "cloudflared: $CLOUDFLARED ($("$CLOUDFLARED" --version | head -1))"

# --- config from template ---
CONFIG="$TUNNEL_DIR/${AGENT}.config.yml"
if [ -f "$CONFIG" ]; then
  echo "config already exists: $CONFIG (not overwritten)"
else
  sed -e "s|<TUNNEL_ID>|${TUNNEL_ID:-<TUNNEL_ID>}|" \
      -e "s|<AGENT>|$AGENT|g" \
      -e "s|<CREDS_FILE>|$CREDS_FILE|" \
      "$TUNNEL_DIR/config.yml" > "$CONFIG"
  echo "wrote $CONFIG"
fi
if [ -n "$TUNNEL_ID" ] && ! grep -q "^tunnel: [0-9a-f-]\{36\}$" "$CONFIG"; then
  sed -i "s|^tunnel: .*|tunnel: $TUNNEL_ID|" "$CONFIG"
  echo "tunnel id set in $CONFIG"
fi

# --- credentials file (mode 600; never created by this script) ---
mkdir -p "$(dirname "$CREDS_FILE")"
if [ -f "$CREDS_FILE" ]; then
  chmod 600 "$CREDS_FILE"
  echo "credentials file: $CREDS_FILE (mode 600)"
else
  echo "credentials file NOT present yet: $CREDS_FILE"
  echo "  Veo must give you the tunnel token via the Secure Vault (see WHAT-TO-ASK-VEO.md);"
  echo "  save it as that file with mode 600. Until then the tunnel cannot run."
fi

# --- resolv.conf for the namespace ---
printf 'nameserver 127.0.0.1\noptions edns0 trust-ad\n' > "$TUNNEL_DIR/resolv.conf"
echo "wrote $TUNNEL_DIR/resolv.conf (namespace-only; global /etc/resolv.conf untouched)"

# --- DNS forwarder: verify it answers, start it if needed ---
mkdir -p "$TUNNEL_DIR/state"
forwarder_ok() {
  dig @127.0.0.1 SRV _v2-origintunneld._tcp.argotunnel.com +short +time=2 +tries=1 2>/dev/null | grep -q "region1.v2.argotunnel.com"
}
if ! forwarder_ok; then
  (setsid --fork python3 "$TUNNEL_DIR/dns-forwarder.py" --host 127.0.0.1 --port 53 \
    --pid-file "$TUNNEL_DIR/state/forwarder.pid" >> "$TUNNEL_DIR/state/forwarder.log" 2>&1 < /dev/null)
  sleep 2
fi
if forwarder_ok; then
  echo "DNS forwarder: answering SRV on 127.0.0.1:53"
else
  echo "DNS forwarder did NOT come up — see $TUNNEL_DIR/state/forwarder.log" >&2
  exit 1
fi
if ! dig @127.0.0.1 A office.sailox.my.id +short +time=3 +tries=1 2>/dev/null | grep -q .; then
  echo "DNS forwarder is NOT forwarding other queries — check $TUNNEL_DIR/state/forwarder.log" >&2
  exit 1
fi
echo "DNS forwarder: forwarding other queries (office.sailox.my.id resolves)"

# --- watchdog hook script: copy, do NOT register ---
mkdir -p "$HOME/hooks/scripts"
cp "$TUNNEL_DIR/tunnel-watchdog.sh" "$HOME/hooks/scripts/${AGENT}-tunnel-watchdog.sh"
chmod +x "$HOME/hooks/scripts/${AGENT}-tunnel-watchdog.sh"
echo "watchdog script copied to ~/hooks/scripts/${AGENT}-tunnel-watchdog.sh (NOT registered — register at go-live, see SETUP-GUIDE.md §6)"

echo
echo "== Phase 1 done. What still needs Veo: =="
cat "$TUNNEL_DIR/WHAT-TO-ASK-VEO.md"

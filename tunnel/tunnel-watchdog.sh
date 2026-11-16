#!/usr/bin/env bash
# tunnel-watchdog.sh — supervision for the tunnel stack (forwarder +
# cloudflared) for one agent. Mirrors the <agent>-office-watchdog pattern:
# PID + health check, setsid --fork restart, wake only on BAHAYA.
#
# Usage (registered as a hook, NOT run by hand):
#   tunnel-watchdog.sh <agent>
#
# States (same AMAN/BAHAYA split as the office watchdog):
#   AMAN   — forwarder/cloudflared was down and the script revived it.
#            No wake, no report. The tunnel is back.
#   BAHAYA — the tunnel cannot be revived (forwarder won't answer SRV,
#            cloudflared keeps exiting, or the config/credentials are
#            missing). Wake the agent ONCE per episode so it can decide
#            (the daemon falls back to WS mode; the office is unaffected).
#
# State file: ~/hooks/state/<agent>-tunnel.json
#   { "status": "up|down|booting", "since": <epoch>, "lastBah": <epoch> }
# Booting (restart < 120 s ago) is left alone; a stale booting state
# (>= 120 s) is treated as a failed restart and retried. After a BAHAYA
# episode, retries are at most once per 5 minutes.
#
# This script is written by the kit but NOT registered by setup.sh —
# registration happens at go-live, when the tunnel actually has a
# real id + token (see SETUP-GUIDE.md). Until then it does nothing
# except exit 0 if run by hand without config.
set -euo pipefail

AGENT="${1:-}"
TUNNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # the kit's tunnel/ dir, wherever it is cloned
STATE_DIR="$HOME/hooks/state"
STATE_FILE="$STATE_DIR/${AGENT}-tunnel.json"
CONFIG="$TUNNEL_DIR/${AGENT}.config.yml"
FORWARDER_PID="$TUNNEL_DIR/state/forwarder.pid"
FORWARDER_LOG="$TUNNEL_DIR/state/forwarder.log"
CLOUDFLARED_PID="$TUNNEL_DIR/state/cloudflared-${AGENT}.pid"
NOW="$(date +%s)"
BOOTING_STALE=120
BAHAYA_COOLDOWN=300

if [ -z "$AGENT" ]; then
  echo "usage: tunnel-watchdog.sh <agent>" >&2
  exit 2
fi
if [ ! -f "$CONFIG" ]; then
  # Tunnel not configured yet (no go-live) — nothing to supervise.
  exit 0
fi

mkdir -p "$STATE_DIR"

read_state() {
  python3 - "$STATE_FILE" <<'PY' 2>/dev/null || echo "down 0 0"
import json, sys
try:
    s = json.load(open(sys.argv[1]))
    print(s.get("status", "down"), s.get("since", 0), s.get("lastBah", 0))
except Exception:
    print("down 0 0")
PY
}
write_state() { # status since lastBah
  python3 - "$STATE_FILE" "$1" "$2" "$3" <<'PY'
import json, sys
json.dump({"status": sys.argv[2], "since": int(sys.argv[3]), "lastBah": int(sys.argv[4])},
          open(sys.argv[1], "w"))
PY
}

forwarder_ok() {
  dig @127.0.0.1 SRV _v2-origintunneld._tcp.argotunnel.com +short +time=2 +tries=1 2>/dev/null \
    | grep -q "region1.v2.argotunnel.com"
}
cloudflared_ok() {
  [ -f "$CLOUDFLARED_PID" ] && kill -0 "$(cat "$CLOUDFLARED_PID" 2>/dev/null)" 2>/dev/null
}

read -r STATUS SINCE LAST_BAH <<< "$(read_state)"

# --- forwarder down: revive it (AMAN if it comes back) ---
if ! forwarder_ok; then
  if [ "$STATUS" = "booting" ] && [ $((NOW - SINCE)) -lt $BOOTING_STALE ]; then
    exit 0  # fresh booting — leave it alone
  fi
  (setsid --fork python3 "$TUNNEL_DIR/dns-forwarder.py" --host 127.0.0.1 --port 53 \
    --pid-file "$FORWARDER_PID" >> "$FORWARDER_LOG" 2>&1 < /dev/null)
  write_state "booting" "$NOW" "$LAST_BAH"
  sleep 2
  if forwarder_ok; then
    write_state "up" "$NOW" "$LAST_BAH"
    exit 0  # AMAN — revived, no wake
  fi
  # fall through to BAHAYA handling below
fi

# --- cloudflared down: revive it ---
if ! cloudflared_ok; then
  if [ "$STATUS" = "booting" ] && [ $((NOW - SINCE)) -lt $BOOTING_STALE ]; then
    exit 0
  fi
  (setsid --fork "$TUNNEL_DIR/run-cloudflared.sh" "$AGENT" >> "$TUNNEL_DIR/state/cloudflared-${AGENT}.log" 2>&1 < /dev/null)
  # run-cloudflared.sh execs cloudflared, so its PID is the child's:
  sleep 2
  pgrep -f "cloudflared tunnel run --config $CONFIG" | head -1 > "$CLOUDFLARED_PID" 2>/dev/null || true
  write_state "booting" "$NOW" "$LAST_BAH"
  sleep 3
  if cloudflared_ok; then
    write_state "up" "$NOW" "$LAST_BAH"
    exit 0  # AMAN — revived, no wake
  fi
fi

# --- still down: BAHAYA, once per episode (5 min cooldown) ---
if [ $((NOW - LAST_BAH)) -ge $BAHAYA_COOLDOWN ]; then
  write_state "down" "$NOW" "$NOW"
  echo "BAHAYA: tunnel $AGENT (forwarder/cloudflared) could not be revived. Daemon falls back to WS mode; office unaffected. See $TUNNEL_DIR/state/ for logs."
  exit 1
fi
write_state "down" "$SINCE" "$LAST_BAH"
exit 0

#!/usr/bin/env bash
# tunnel-aws.sh — TEMPLATE (kit). Supervise the reverse-SSH tunnel
# VM -> AWS that carries one agent's push channel (office ->
# https://<agent>.sailox.my.id/push -> cloudflared on AWS ->
# 127.0.0.1:<remote-port> -> daemon 127.0.0.1:<local-port>).
#
# RYN ONLY (Veo, 2026-11-16) — no other AI gets a tunnel or AWS SSH
# key. This template exists so the pattern is documented, not as a
# right: another agent may use it ONLY with Veo's explicit approval
# plus its own SSH key to the AWS VPS (alias aws-vps-slx).
#
# Usage (registered as a hook, NOT run by hand):
#   tunnel-aws.sh <agent> [kit-dir] [ssh-host] [remote-port] [local-port]
#   <agent>       e.g. ryn — the hook name is <agent>-tunnel-aws
#   [ssh-host]    default aws-vps-slx (the SSH alias for the AWS VPS)
#   [remote-port] default 18789 (the forwarded port on the AWS side)
#   [local-port]  default 8789 (the daemon's local port)
#
# The tunnel is one ssh process:
#   ssh -N -R 127.0.0.1:18789:127.0.0.1:8789 aws-vps-slx
# (loopback-only on AWS; ExitOnForwardFailure + ServerAlive so a dead
# tunnel exits on its own instead of lingering half-open.)
#
# Fully deterministic, mirrors office-watchdog.sh: the probe is a
# fresh SSH to AWS that curls the forwarded port; a healthy tunnel
# answers /health with ok:true. AMAN = tunnel was down and the script
# revived it (no wake, no report). BAHAYA = the tunnel cannot be
# revived; wake the agent ONCE per episode (5 min backoff). While the
# tunnel is down, push delivery to this agent is down (WS is still blocked by
# the VM egress fault), so the agent is unreachable until it comes back.
#
# State episode: ~/hooks/state/<agent>-tunnel-aws.json (since = waktu upaya
# pemulihan terakhir yang gagal; dipakai sebagai jam backoff).
# State booting: ~/hooks/state/<agent>-tunnel-aws-boot.json
# ({"status":"booting","since":...}, ditulis saat recovery dimulai,
# dihapus saat recovery selesai; umur > 120 dtk dianggap basi).
# PID file: agent-kit/state/tunnel-aws.pid (ssh PID, via pgrep -f).
# Log: agent-kit/logs/tunnel-aws.log (ssh stderr).
# Kunci flock di awal main(): dua run tidak pernah jalan barengan.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

AGENT="${1:-}"
KIT_DIR="${2:-$HOME/workspace/00_Projects/Experimental/single-office/agent-kit}"
SSH_HOST="${3:-aws-vps-slx}"
REMOTE_PORT="${4:-18789}"
LOCAL_PORT="${5:-8789}"
if [ -z "$AGENT" ]; then echo "usage: tunnel-aws.sh <agent> [kit-dir] [ssh-host] [remote-port] [local-port]" >&2; exit 2; fi
SSH_CONFIG="/home/hatch/.ssh/config"
PID_FILE="$KIT_DIR/state/tunnel-aws.pid"
LOG_FILE="$KIT_DIR/logs/tunnel-aws.log"
STATE_FILE="$HOME/hooks/state/${AGENT}-tunnel-aws.json"
BOOT_FILE="$HOME/hooks/state/${AGENT}-tunnel-aws-boot.json"
BOOT_TIMEOUT_SECS=120
RETRY_BACKOFF_SECS=300
DRY="${HATCH_HOOK_DRY_RUN:-0}"
SSH_PATTERN="${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}"
mkdir -p "$HOME/hooks/state" "$KIT_DIR/logs" "$KIT_DIR/state"

# --- state episode (tulis hanya di live run, bukan dry run) ---
write_state() { if [ "$DRY" != "1" ]; then printf '%s' "$1" > "$STATE_FILE"; fi; }
clear_state() { if [ "$DRY" != "1" ]; then rm -f "$STATE_FILE"; fi; }
episode_active() { [ -f "$STATE_FILE" ]; }

# --- state booting (json, menetap di disk sehingga lolos VM restart) ---
set_booting() { if [ "$DRY" != "1" ]; then printf '{"status":"booting","since":"%s"}' "$(date -u +%FT%TZ)" > "$BOOT_FILE"; fi; }
clear_booting() { if [ "$DRY" != "1" ]; then rm -f "$BOOT_FILE"; fi; }
boot_age_secs() {
  local st since now t
  [ -f "$BOOT_FILE" ] || { echo ""; return 0; }
  st="$(jq -r '.status // empty' "$BOOT_FILE" 2>/dev/null)"
  [ "$st" = "booting" ] || { echo ""; return 0; }
  since="$(jq -r '.since // empty' "$BOOT_FILE" 2>/dev/null)"
  [ -n "$since" ] || { echo ""; return 0; }
  t="$(date -d "$since" +%s 2>/dev/null)" || { echo ""; return 0; }
  now="$(date +%s)"
  echo $(( now - t ))
}
episode_age_secs() {
  local since now t
  [ -f "$STATE_FILE" ] || { echo ""; return 0; }
  since="$(jq -r '.since // empty' "$STATE_FILE" 2>/dev/null)"
  [ -n "$since" ] || { echo ""; return 0; }
  t="$(date -d "$since" +%s 2>/dev/null)" || { echo ""; return 0; }
  now="$(date +%s)"
  echo $(( now - t ))
}

# Wake sekali per episode; bila episode sudah dilaporkan, diam saja.
wake_once() { # $1 = alasan, $2 = payload json
  if episode_active; then
    write_state "{\"since\":\"$(date -u +%FT%TZ)\",\"reason\":$(printf '%s' "$1" | jq -Rs .)}"
    log "bahaya-sudah-dilaporkan" "$2"
    silent "BAHAYA masih berlangsung, sudah dilaporkan sebelumnya" "$2"
    exit 0
  fi
  write_state "{\"since\":\"$(date -u +%FT%TZ)\",\"reason\":$(printf '%s' "$1" | jq -Rs .)}"
  log "bahaya" "$2"
  wake "$1" "$2"
  exit 0
}

# tunnel_health: "ok" bila hop AWS->127.0.0.1:18789 menjawab /health
# dengan ok:true; "down" bila tidak; "timeout" bila probe SSH/curl
# menggantung (tak dapat dipastikan). Return 0 selalu; status lewat stdout.
tunnel_health() {
  local body rc
  rc=0
  body="$(timeout 25 ssh -F "$SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" "curl --fail --silent --max-time 10 http://127.0.0.1:${REMOTE_PORT}/health" 2>/dev/null)" || rc=$?
  if [ "$rc" = "124" ] || [ "$rc" = "28" ]; then echo "timeout"; return 0; fi
  if [ "$rc" != "0" ]; then echo "down"; return 0; fi
  if [ "$(printf '%s' "$body" | jq -r '.ok // false' 2>/dev/null)" = "true" ]; then
    echo "ok"
  else
    echo "down"
  fi
  return 0
}

# ssh_pid: PID proses ssh terowongan (via pgrep -f); kosong bila tidak ada.
ssh_pid() {
  pgrep -f "$SSH_PATTERN" 2>/dev/null | head -1 || true
}

# pid_alive: 1 bila PID file ada dan prosesnya hidup, 0 bila tidak.
pid_alive() {
  local pid
  [ -f "$PID_FILE" ] || { echo 0; return 0; }
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && { echo 1; return 0; }
  echo 0
}

start_tunnel() {
  if [ "$DRY" = "1" ]; then
    log "dry-run-start" '{"would_start":true}'
    return 0
  fi
  # setsid --fork: ssh lepas ke sesi baru supaya tidak ikut mati saat
  # run hook selesai/timeout (pelajaran dari sailox-watchdog).
  # PID diambil lewat pgrep -f sesudah start (setsid --fork tidak
  # mengembalikan PID anaknya).
  (setsid --fork nohup ssh -F "$SSH_CONFIG" -N -R 127.0.0.1:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT} \
    -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ConnectTimeout=30 "$SSH_HOST" >> "$LOG_FILE" 2>&1 < /dev/null)
  sleep 2
  local pid
  pid="$(ssh_pid)"
  if [ -n "$pid" ]; then printf '%s' "$pid" > "$PID_FILE"; fi
}

stop_tunnel() {
  local pid
  pid="$(ssh_pid)"
  [ -n "$pid" ] || return 0
  if [ "$DRY" = "1" ]; then
    log "dry-run-stop" "{\"would_stop_pid\":$pid}"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

# wait_healthy: probe sampai ~6x (tiap ~2 dtk) sampai hop menjawab.
# Return 0 bila ok.
wait_healthy() {
  local i
  for i in $(seq 1 6); do
    [ "$(tunnel_health)" = "ok" ] && return 0
    sleep 2
  done
  return 1
}

# recover_tunnel: stop (bila ada), start, tunggu sehat; sekali retry.
# Sukses -> diam (AMAN). Gagal -> wake BAHAYA (sekali per episode).
recover_tunnel() { # $1 = alasan
  local reason="$1"
  set_booting
  stop_tunnel || true
  start_tunnel || true
  if wait_healthy; then
    clear_booting
    clear_state
    log "tunnel-pulih" "{\"alasan\":\"$reason\"}"
    silent "terowongan SSH balik ke AWS pulih setelah $reason" '{}'
    exit 0
  fi
  stop_tunnel || true
  start_tunnel || true
  if wait_healthy; then
    clear_booting
    clear_state
    log "tunnel-pulih-retry" "{\"alasan\":\"$reason\"}"
    silent "terowongan SSH balik ke AWS pulih setelah retry $reason" '{}'
    exit 0
  fi
  clear_booting
  wake_once "BAHAYA: terowongan SSH balik ke AWS mati dan gagal dipulihkan — push ke $AGENT putus" "{\"alasan\":\"$reason\"}"
}

# maybe_recover: pulihkan hanya bila memang perlu.
# - Masih booting (state json, umur < BOOT_TIMEOUT_SECS) -> biarin.
# - BAHAYA sudah dilaporkan dan upaya gagal terakhir < RETRY_BACKOFF_SECS
#   lalu -> biarin (jangan nge-spam start ke ssh yang lagi rusak).
# - Selain itu -> recover_tunnel (yang menulis state booting dulu).
maybe_recover() { # $1 = alasan
  local age eage
  age="$(boot_age_secs)"
  if [ -n "$age" ] && [ "$age" -lt "$BOOT_TIMEOUT_SECS" ]; then
    silent "terowongan masih booting (state umur ${age} dtk), biarin" '{}'
    exit 0
  fi
  eage="$(episode_age_secs)"
  if [ -n "$eage" ] && [ "$eage" -lt "$RETRY_BACKOFF_SECS" ]; then
    silent "BAHAYA sudah dilaporkan ${eage} dtk lalu, tunggu sebelum coba pulihkan lagi" '{}'
    exit 0
  fi
  recover_tunnel "$1"
}

main() {
  # Kunci anti-tabrakan: bila ada run lain (mis. recovery) masih jalan,
  # run ini langsung diam — recovery yang sedang jalan sudah mengurusnya.
  exec 9>"$HOME/hooks/state/${AGENT}-tunnel-aws.lock"
  if ! flock -n 9; then
    silent "tunnel watchdog sudah berjalan di run lain, lewati" '{}'
    exit 0
  fi
  if ! command -v ssh >/dev/null 2>&1; then
    wake_once "BAHAYA: ssh tidak ditemukan di PATH, terowongan balik ke AWS tidak bisa jalan" '{"ssh":"missing"}'
  fi

  local health
  health="$(tunnel_health)"
  if [ "$health" = "timeout" ]; then
    log "health-timeout" '{}'
    silent "probe terowongan timeout; tidak dapat dipastikan, tunggu poll berikut" '{}'
    exit 0
  fi
  if [ "$health" = "ok" ]; then
    # Hop sehat: bersihkan episode lama (bila ada) supaya BAHAYA
    # berikutnya bisa dilaporkan lagi.
    clear_state
    silent "terowongan SSH balik ke AWS sehat (hop 127.0.0.1:${REMOTE_PORT} menjawab /health)" '{}'
    exit 0
  fi
  # Hop down: ssh mati, atau hidup tapi forward-nya putus.
  if [ "$(pid_alive)" = "1" ]; then
    maybe_recover "proses ssh hidup tapi hop 127.0.0.1:${REMOTE_PORT} tidak menjawab (forward putus)"
  else
    maybe_recover "terowongan mati (tidak ada proses ssh + hop tidak menjawab)"
  fi
}

main "$@"

#!/usr/bin/env bash
# office-watchdog.sh — TEMPLATE (kit). Cek daemon <agent>-side tiap
# poll, pulihkan bila mati. Sepenuhnya deterministik (PID file + GET
# /health lokal). Diam bila AMAN; bangunkan agen hanya bila BAHAYA
# (pemulihan gagal), dan hanya sekali per episode mati. Mirip
# sailox-watchdog.
#
# Usage (registered as a hook, NOT run by hand):
#   office-watchdog.sh <agent> [kit-dir] [port]
#   <agent>   e.g. finch — the hook name is <agent>-office-watchdog
#   [kit-dir] default ~/workspace/00_Projects/Experimental/single-office/agent-kit
#   [port]    default 8789 (must match AGENT_LOCAL_PORT)
# State episode: ~/hooks/state/<agent>-office-watchdog.json (since =
# waktu upaya pemulihan terakhir yang gagal; dipakai sebagai jam backoff
# — setelah gagal, upaya berikutnya paling cepat 5 menit kemudian).
# State booting: ~/hooks/state/<agent>-office-watchdog-boot.json
# ({"status":"booting","since":...}, ditulis saat recovery dimulai,
# dihapus saat recovery selesai; umur > 120 dtk dianggap basi — booternya
# mati, mis. VM restart — lalu recovery boleh jalan lagi).
# Kunci flock di awal main(): dua run tidak pernah jalan barengan.
# TOKEN: mirror the daemon's own resolution (agent-kit/src/vault.js).
# The daemon uses the token FILE if one exists, else the Secure Vault
# (a fresh surrogate from authd on every (re)connect). The watchdog
# checks the same source the daemon would use — never a file the daemon
# does not use. A hook script CAN reach the vault: bin/get-surrogate.py
# works in the hook runtime (verified 2026-11-16 by dry-run probe,
# vault_ok:true in ~170 ms). The surrogate value is never logged.
# The token check runs ONLY when /health is down (see main): a live
# daemon never reaches it. Before 2026-11-16 the gate checked the file
# first and woke a false BAHAYA "token missing" on a healthy daemon.
# Bila token tidak tersedia, watchdog TIDAK mencoba restart (daemon
# akan langsung exit); ia membangunkan agen sekali (BAHAYA) supaya
# token disediakan dulu. Lihat RUNBOOK.md §4.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

AGENT="${1:-}"
KIT_DIR="${2:-$HOME/workspace/00_Projects/Experimental/single-office/agent-kit}"
LOCAL_PORT="${3:-8789}"
if [ -z "$AGENT" ]; then echo "usage: office-watchdog.sh <agent> [kit-dir] [port]" >&2; exit 2; fi
PID_FILE="$KIT_DIR/state/daemon.pid"
TOKEN_FILE="$HOME/.config/single-office/${AGENT}-token"
SURROGATE_SCRIPT="$KIT_DIR/bin/get-surrogate.py"
LOG_FILE="$KIT_DIR/logs/daemon.log"
HEALTH_URL="http://127.0.0.1:${LOCAL_PORT}/health"
STATE_FILE="$HOME/hooks/state/${AGENT}-office-watchdog.json"
BOOT_FILE="$HOME/hooks/state/${AGENT}-office-watchdog-boot.json"
BOOT_TIMEOUT_SECS=120
RETRY_BACKOFF_SECS=300
DRY="${HATCH_HOOK_DRY_RUN:-0}"
mkdir -p "$HOME/hooks/state" "$KIT_DIR/logs"

# --- state episode (tulis hanya di live run, bukan dry run) ---
write_state() { if [ "$DRY" != "1" ]; then printf '%s' "$1" > "$STATE_FILE"; fi; }
clear_state() { if [ "$DRY" != "1" ]; then rm -f "$STATE_FILE"; fi; }
episode_active() { [ -f "$STATE_FILE" ]; }

# --- state booting (json, menetap di disk sehingga lolos VM restart) ---
set_booting() { if [ "$DRY" != "1" ]; then printf '{"status":"booting","since":"%s"}' "$(date -u +%FT%TZ)" > "$BOOT_FILE"; fi; }
clear_booting() { if [ "$DRY" != "1" ]; then rm -f "$BOOT_FILE"; fi; }
# boot_age_secs: umur state booting (detik); kosong bila tidak ada, status
# bukan "booting", atau isinya rusak — ketiganya dianggap "tidak booting"
# sehingga recovery boleh jalan (fail-open: state rusak tidak boleh
# mematikan watchdog).
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
# episode_age_secs: umur upaya pemulihan gagal terakhir (detik); kosong
# bila tidak ada episode atau isinya rusak.
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
    # Segarkan jam backoff (upaya gagal barusan), tanpa membangunkan lagi.
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

# daemon_health: cetak "ok" bila /health menjawab 200 + ok:true,
# "down" bila tidak terjangkau, "timeout" bila curl timeout (tak dapat
# dipastikan). Return 0 selalu; status lewat stdout.
daemon_health() {
  local body rc
  rc=0
  body="$(curl --fail --silent --max-time 10 "$HEALTH_URL" 2>/dev/null)" || rc=$?
  if [ "$rc" = "28" ]; then echo "timeout"; return 0; fi
  if [ "$rc" != "0" ]; then echo "down"; return 0; fi
  if [ "$(printf '%s' "$body" | jq -r '.ok // false' 2>/dev/null)" = "true" ]; then
    echo "ok"
  else
    echo "down"
  fi
  return 0
}

# pid_alive: 1 bila PID file ada dan prosesnya hidup, 0 bila tidak.
pid_alive() {
  local pid
  [ -f "$PID_FILE" ] || { echo 0; return 0; }
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && { echo 1; return 0; }
  echo 0
}

# --- token: mirror the daemon's own resolution (src/vault.js) ---
# token_file_ok: 1 bila file token ada dan berisi tepat satu baris
# tak-kosong (validasi daemon sendiri); 0 bila tidak ada / kosong / rusak.
token_file_ok() {
  local n
  [ -f "$TOKEN_FILE" ] || { echo 0; return 0; }
  [ -s "$TOKEN_FILE" ] || { echo 0; return 0; }
  n="$(awk 'NF {c++} END {print c+0}' "$TOKEN_FILE" 2>/dev/null || true)"
  [ "$n" = "1" ] && { echo 1; return 0; }
  echo 0
}

# vault_ok: 1 bila authd mengembalikan surrogate segar (hsurr:...).
# Nilai surrogate TIDAK PERNAH di-log/di-echo — hanya dicek prefix-nya,
# lalu langsung di-unset.
vault_ok() {
  local out rc
  out=""
  rc=0
  out="$(timeout 15 python3 "$SURROGATE_SCRIPT" 2>/dev/null)" || rc=$?
  if [ "$rc" = "0" ] && [ "${out#hsurr:}" != "$out" ]; then
    unset out
    echo 1
    return 0
  fi
  unset out
  echo 0
}

# daemon_log_has_token_failure: 1 bila log daemon (100 baris terakhir)
# menunjukkan daemon tidak bisa mengambil surrogate dari vault — laporan
# daemon sendiri soal vault. Dipakai hanya untuk mengonfirmasi kegagalan
# vault_ok, supaya gangguan authd sesaat tidak jadi BAHAYA "token
# missing" palsu.
daemon_log_has_token_failure() {
  [ -f "$LOG_FILE" ] || { echo 0; return 0; }
  if tail -n 100 "$LOG_FILE" 2>/dev/null | grep -q "cannot obtain an office token surrogate\|vault returned a non-surrogate value"; then
    echo 1
  else
    echo 0
  fi
}

# token_status: "ok" | "file-malformed" | "missing".
# File (bila ada) menang atas vault, persis seperti src/vault.js.
# Kegagalan vault_ok hanya dipercaya bila log daemon mengonfirmasi
# kegagalan token (fail-open: cek yang tak meyakinkan tidak boleh
# memblokir recovery — daemon fail-fast bila token memang bermasalah,
# dan kegagalan recovery itu tetap dilaporkan sebagai BAHAYA).
token_status() {
  if [ -f "$TOKEN_FILE" ]; then
    if [ "$(token_file_ok)" = "1" ]; then echo "ok"; else echo "file-malformed"; fi
    return 0
  fi
  if [ "$(vault_ok)" = "1" ]; then echo "ok"; return 0; fi
  if [ "$(daemon_log_has_token_failure)" = "1" ]; then echo "missing"; return 0; fi
  echo "ok"
}

start_daemon() {
  if [ "$DRY" = "1" ]; then
    log "dry-run-start" '{"would_start":true}'
    return 0
  fi
  # setsid --fork: induk langsung keluar setelah fork; daemon jadi anak
  # init di sesi baru. Tanpa --fork, subshell penampung menunggu daemon
  # selamanya (daemon abadi) sehingga run hook menggantung sampai timeout
  # lalu daemon ikut dimatikan saat timeout — pelajaran dari sailox.
  (cd "$KIT_DIR" && setsid --fork nohup node src/cli.js daemon >> "$LOG_FILE" 2>&1 < /dev/null)
}

stop_daemon() {
  local pid
  [ -f "$PID_FILE" ] || return 0
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] || return 0
  if [ "$DRY" = "1" ]; then
    log "dry-run-stop" "{\"would_stop_pid\":$pid}"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  # Tunggu max ~10 dtk sampai proses benar-benar mati.
  local i
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

# wait_healthy: tunggu max ~10 dtk sampai /health ok. Return 0 bila ok.
wait_healthy() {
  local i
  for i in $(seq 1 10); do
    [ "$(daemon_health)" = "ok" ] && return 0
    sleep 1
  done
  return 1
}

# recover_daemon: stop (bila ada), start, tunggu sehat; sekali retry.
# Sukses -> diam (AMAN). Gagal -> wake BAHAYA (sekali per episode).
recover_daemon() { # $1 = alasan
  local reason="$1"
  set_booting
  stop_daemon || true
  start_daemon || true
  if wait_healthy; then
    clear_booting
    clear_state
    log "daemon-pulih" "{\"alasan\":\"$reason\"}"
    silent "daemon $AGENT-side pulih setelah $reason" '{}'
    exit 0
  fi
  stop_daemon || true
  start_daemon || true
  if wait_healthy; then
    clear_booting
    clear_state
    log "daemon-pulih-retry" "{\"alasan\":\"$reason\"}"
    silent "daemon $AGENT-side pulih setelah retry $reason" '{}'
    exit 0
  fi
  clear_booting
  wake_once "BAHAYA: daemon $AGENT-side mati dan gagal dipulihkan" "{\"alasan\":\"$reason\"}"
}

# maybe_recover: pulihkan hanya bila memang perlu.
# - Masih booting (state json, umur < BOOT_TIMEOUT_SECS) -> biarin.
# - BAHAYA sudah dilaporkan dan upaya gagal terakhir < RETRY_BACKOFF_SECS
#   lalu -> biarin (jangan nge-spam start ke daemon yang lagi rusak).
# - Selain itu -> recover_daemon (yang menulis state booting dulu).
maybe_recover() { # $1 = alasan
  local age eage
  age="$(boot_age_secs)"
  if [ -n "$age" ] && [ "$age" -lt "$BOOT_TIMEOUT_SECS" ]; then
    silent "daemon masih booting (state umur ${age} dtk), biarin" '{}'
    exit 0
  fi
  eage="$(episode_age_secs)"
  if [ -n "$eage" ] && [ "$eage" -lt "$RETRY_BACKOFF_SECS" ]; then
    silent "BAHAYA sudah dilaporkan ${eage} dtk lalu, tunggu sebelum coba pulihkan lagi" '{}'
    exit 0
  fi
  recover_daemon "$1"
}

main() {
  # Kunci anti-tabrakan: bila ada run lain (mis. recovery) masih jalan,
  # run ini langsung diam — recovery yang sedang jalan sudah mengurusnya.
  exec 9>"$HOME/hooks/state/${AGENT}-office-watchdog.lock"
  if ! flock -n 9; then
    silent "watchdog sudah berjalan di run lain, lewati" '{}'
    exit 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    wake_once "BAHAYA: node tidak ditemukan di PATH, daemon $AGENT-side tidak bisa jalan" '{"node":"missing"}'
  fi

  local health
  health="$(daemon_health)"
  if [ "$health" = "timeout" ]; then
    log "health-timeout" '{}'
    silent "cek /health timeout; tidak dapat dipastikan, tunggu poll berikut" '{}'
    exit 0
  fi
  if [ "$health" = "ok" ]; then
    # Daemon sehat: bersihkan episode lama (bila ada) supaya BAHAYA
    # berikutnya bisa dilaporkan lagi.
    clear_state
    silent "daemon $AGENT-side sehat (/health ok)" '{}'
    exit 0
  fi
  # /health down: baru sekarang cek token — daemon yang hidup tidak
  # pernah sampai ke gate ini. Token tidak ada -> restart tidak akan
  # pernah berhasil (daemon fail-fast exit). Jangan spam restart;
  # bangunkan agen sekali supaya token disediakan dulu (RUNBOOK.md §4).
  local tstat
  tstat="$(token_status)"
  if [ "$tstat" = "file-malformed" ]; then
    wake_once "BAHAYA: token file office rusak — daemon $AGENT-side tidak bisa boot" '{"token":"file-malformed"}'
  fi
  if [ "$tstat" = "missing" ]; then
    wake_once "BAHAYA: token office belum tersedia di vault — daemon $AGENT-side tidak bisa boot" '{"token":"missing","source":"vault"}'
  fi
  # /health down: daemon mati, atau proses hidup tapi HTTP-nya macet.
  if [ "$(pid_alive)" = "1" ]; then
    maybe_recover "proses daemon hidup tapi /health tidak menjawab (macet)"
  else
    maybe_recover "daemon mati (tidak ada proses + /health down)"
  fi
}

main "$@"

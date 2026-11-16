#!/usr/bin/env bash
# office-watch.sh — TEMPLATE (kit). Cek mailbox lokal <agent>-side
# (inbox/) tanpa bangunin agen. Script ringan (ls lokal) tiap poll;
# agen cuma dibangunkan kalau ada delivery BARU dari office (file JSON
# baru di inbox/). Mirip bridge-watch, tapi lokal — tidak ada SSH, tidak
# ada polling ke office (aturan Q-21: daemon yang menerima, hook ini
# hanya melihat file yang sudah difile-kan daemon).
#
# Usage (registered as a hook, NOT run by hand):
#   office-watch.sh <agent> [kit-dir]
#   <agent>   e.g. finch — the hook name is <agent>-office-watch
#   [kit-dir] default ~/workspace/00_Projects/Experimental/single-office/agent-kit
# State: ~/hooks/state/<agent>-office-watch-seen.txt (nama file yang
# sudah dilihat; satu baris per file).
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

AGENT="${1:-}"
KIT_DIR="${2:-$HOME/workspace/00_Projects/Experimental/single-office/agent-kit}"
if [ -z "$AGENT" ]; then echo "usage: office-watch.sh <agent> [kit-dir]" >&2; exit 2; fi
INBOX_DIR="$KIT_DIR/inbox"
STATE_FILE="$HOME/hooks/state/${AGENT}-office-watch-seen.txt"
mkdir -p "$HOME/hooks/state"

if [ ! -d "$INBOX_DIR" ]; then
  silent "inbox $AGENT-side belum ada (daemon belum pernah jalan)" '{}'
fi

INBOX_LIST="$(ls -1 "$INBOX_DIR" 2>/dev/null | grep '\.json$' || true)"

if [ -z "$INBOX_LIST" ]; then
  silent "inbox $AGENT-side kosong" '{}'
fi

# File baru = ada di listing inbox tapi belum ada di state.
NEW_FILES=""
if [ -f "$STATE_FILE" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! grep -qxF "$f" "$STATE_FILE" 2>/dev/null; then
      NEW_FILES="${NEW_FILES}${f}
"
    fi
  done <<EOF
$INBOX_LIST
EOF
else
  NEW_FILES="$INBOX_LIST"
fi

if [ -z "$NEW_FILES" ]; then
  silent "tidak ada delivery baru di inbox $AGENT-side" '{}'
fi

# Tulis state BARU hanya di live run (bukan dry run) supaya tidak bangun
# ulang untuk file yang sama.
if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
  printf '%s\n' "$INBOX_LIST" > "$STATE_FILE"
fi

NEW_CSV="$(printf '%s' "$NEW_FILES" | tr '\n' ',' | sed 's/,$//')"
log "delivery-baru" "{\"files\":\"$NEW_CSV\"}"
wake "delivery baru dari office di inbox $AGENT-side" "{\"files\":\"$NEW_CSV\"}"

# RUNBOOK — agent-kit (Single Office internal API)

**For the AI (<agent>).** You have no prior context. This file tells you how
to check, restart, and fix the daemon that connects you to Single
Office. Read the section you need; do not guess.

## What this is

- **Code:** `~/workspace/00_Projects/Experimental/single-office/agent-kit/`
- **Daemon:** a Node process (`node src/cli.js daemon`) that holds an
  outbound WebSocket to `https://office.sailox.my.id`, receives
  messages, files one JSON per delivery in `inbox/`, and acks them.
- **Local HTTP (127.0.0.1 only, port 8789):** `GET /health`, `GET /`,
  `GET /inbox`, `POST /push` (localhost push receiver — the office
  cannot reach it; WS is the live mode).
- **Wake:** hook `<agent>-office-watch` (5 s) lists `inbox/*.json` vs its
  seen-state and wakes you on new files. **Auto-restart:** hook
  `<agent>-office-watchdog` (5 s), PID file + `/health`, restart via
  `setsid --fork`.
- **Token:** env `OFFICE_AGENT_TOKEN` or file
  `~/.config/single-office/<agent>-token` (mode 600). Re-read before every
  (re)connect. The watchdog's restarts use the TOKEN FILE (hooks carry
  no secrets).

## 1. Is it healthy? (30 seconds)

```bash
curl -s --max-time 5 http://127.0.0.1:8789/health
```

Healthy looks like:

```json
{"ok":true,"service":"<agent>-side","mode":"ws-outbound","wsConnected":true,"inboxPending":0,"uptimeSeconds":1234,"startedAt":"..."}
```

- `ok:true` + `wsConnected:true` → healthy. Nothing to do.
- `ok:true` + `wsConnected:false` → the daemon is alive but the WS is
  down. Check the log (step 2) — usually a bad/expired token (see
  §4) or the office being unreachable. The daemon retries with
  backoff on its own; give it a minute, then check again.
- No answer / connection refused → the daemon is down. Go to §3.
- `curl` hangs until `--max-time` → inconclusive; do NOT restart on a
  timeout alone. Wait for the next poll / check again in a minute.

Also useful:

```bash
node src/cli.js health        # same check via the CLI (from agent-kit/)
node src/cli.js me            # who the office thinks I am (needs token)
tail -20 logs/daemon.log      # last daemon output
cat state/daemon.pid          # PID the daemon wrote at boot
ps -p $(cat state/daemon.pid) # is that PID actually alive?
```

## 2. Where the logs are

- **Daemon log:** `agent-kit/logs/daemon.log` (stdout+stderr of the
  supervised daemon). Start here for any failure.
- **Hook logs (JSONL):** `~/hooks/logs/<agent>-office-watch.jsonl` and
  `~/hooks/logs/<agent>-office-watchdog.jsonl` — one line per poll with
  the decision (silent/wake) and reason.
- **Hook scripts:** `~/hooks/scripts/<agent>-office-watch.sh`,
  `~/hooks/scripts/<agent>-office-watchdog.sh`.
- **Hook state:** `~/hooks/state/<agent>-office-watch-seen.txt` (files
  already seen), `~/hooks/state/<agent>-office-watchdog.json` (BAHAYA
  episode), `~/hooks/state/<agent>-office-watchdog-boot.json` (booting).

## 3. Restart the daemon

**Manual restart (foreground, for debugging — Ctrl-C stops it):**

```bash
cd ~/workspace/00_Projects/Experimental/single-office/agent-kit
node src/cli.js daemon
```

**Supervised restart (what the watchdog does — survives your shell):**

```bash
cd ~/workspace/00_Projects/Experimental/single-office/agent-kit
(setsid --fork nohup node src/cli.js daemon >> logs/daemon.log 2>&1 < /dev/null)
sleep 3
curl -s --max-time 5 http://127.0.0.1:8789/health
```

The `setsid --fork` matters: without it the parent shell waits for the
abadi daemon forever, the hook run hangs 180 s and the timeout kills
the daemon with it. Never start the supervised daemon any other way.

**Stop it:**

```bash
kill $(cat state/daemon.pid)   # graceful (SIGTERM removes the PID file)
```

**Let the watchdog do it:** if the watchdog hook is enabled, just wait
— it polls every 5 s and restarts a dead daemon itself (verified:
kill → healthy in ~4 s, restart itself ~1.1 s). Only restart by hand
if the watchdog is disabled or has already woken you with BAHAYA.

**After a VM replacement:** the daemon and the hook state are gone.
Re-run the enable steps in §6, then start the daemon supervised
(above) and confirm `/health`.

## 4. Token problems (missing / expired / refused)

The token lives ONLY in the Secure Vault as the registered connection
`custom.single-office`. The daemon and the CLI fetch a FRESH surrogate
from authd before every (re)connect and every REST call
(`src/vault.js`, `bin/get-surrogate.py`). The surrogate string itself
is never logged and never written anywhere. There is no token file to
place and nothing to restart when the token is rotated: the next
attempt fetches a fresh surrogate, so a rotated vault credential is
picked up on its own.

Symptoms in `logs/daemon.log`:

- `cannot obtain an office token surrogate from the vault: ...`
  → **authd cannot provide a surrogate.** At boot the daemon exits
  immediately; the watchdog will NOT restart it (restarting would
  fail the same way) and wakes you once with BAHAYA instead. A
  running daemon logs this per attempt and keeps retrying with
  backoff. First check the vault path without exposing anything:
  `python3 ~/workspace/custom-connectors/custom.single-office/bin/office.py me`
  — if it returns your agent's name, the vault is healthy and the failure was
  transient, so wait. If it fails too, the vault credential itself is
  missing or stale (see the fix below). Never run
  `bin/get-surrogate.py` bare: it prints the surrogate to stdout.
- `WS auth refused: unauthorized (check the token; retrying with backoff)`
  → **token wrong, revoked, or expired.** The daemon stays alive and
  retries forever. `/health` stays `ok:true` but `wsConnected:false`.
  Each retry fetches a fresh surrogate, so if Veo has already rotated
  the credential in the vault, the daemon recovers on its own. If it
  does not recover, the vault credential is stale (see the fix below).
- `Office token file is empty` / `must contain a single token`
  → **the token FILE is malformed.** This only happens when a real
  token is supplied outside the vault (the file wins over the vault).
  Fix or delete the file (`~/.config/single-office/<agent>-token`, mode
  600), then restart supervised (§3).

Fix (vault cases): **you cannot fix this alone.** The token is a
one-time office token that only Veo can issue (he creates/rotates it
in `/admin/agents`). Report to Veo, in the Single Office chat, that a
fresh token is needed, and that he must put it in the Secure Vault —
**never ask for the token value in chat, never paste it anywhere.**
Once he has, there is nothing to place and nothing to restart: the
daemon picks the fresh credential up on its next attempt. Do NOT edit
the office database or the VPS to work around it.

The push secret has its own rule — see §9. Do not confuse the two:
the token's surrogate IS usable (it is sent to the office and
swapped in transit); the push secret's surrogate is NOT (HMACs are
verified locally). The push secret is delivered by the office
itself (`GET /api/v1/agent/push-secret`); the vault provider
`custom.single-office-push` is only a presence record.

## 5. Common failures and their fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` no answer, no PID file, log ends at boot | Daemon crashed at boot | Read the last lines of `logs/daemon.log`; fix the cause (usually §4 token, or a bad `AGENT_LOCAL_PORT`), then start supervised (§3). |
| `/health` no answer, PID file exists, PID dead | Stale PID after a kill/VM restart | The watchdog clears this itself (PID dead → restart). By hand: `rm -f state/daemon.pid`, then start supervised. |
| `/health` no answer, PID alive | Daemon stuck (HTTP server wedged) | `kill <pid>`, wait 2 s, start supervised. If it recurs, read the log and report it — do not loop restarts by hand; the watchdog's 5-min backoff exists for this. |
| `EADDRINUSE` / port 8789 taken | Two daemons, or another process on 8789 | Find it: `ss -ltnp | grep 8789` (or `lsof -i :8789`). If it is an old agent-kit daemon, kill it. If it is something else, set `AGENT_LOCAL_PORT` to a free port (and pass the same port when registering the watchdog hook — it takes the port as an argument; see below). |
| `WS auth refused: unauthorized` | Token wrong/revoked/expired | §4. Do not "fix" by editing office code or the DB. |
| No WS lines at all in the log, `/health` shows `wsConnected:false`, daemon retries silently | Node's built-in WebSocket cannot open a WS from this VM (observed on Ryn's VM 2026-11-16 ~03:19-03:24 UTC: every attempt fails fast with close code 1006, while curl's WS upgrade returns 101; regression since 02:47 UTC, when the same daemon boot received 44 unauthorized within 2 s — your VM may or may not have the same gate) | Nothing known from the VM side. Do NOT switch WS libraries, extract the token, or ask Veo for the token in chat. Report the exact failure to the parent/Veo and wait for a decision. REST through the connector helper keeps working meanwhile. |
| Office unreachable (`fetch failed`, `ENOTFOUND`, proxy errors) | Network/proxy or the office is down | Check `curl -s https://office.sailox.my.id/api/health` — 200 means the office is up and the problem is this VM's egress. The daemon retries on its own; wait. If the office itself is down, that is a VPS matter — report it, do not touch the VPS. |
| Watchdog wakes BAHAYA repeatedly | Real failure the watchdog cannot fix | Read the wake reason + `logs/daemon.log`. If the reason is the token → §4. Otherwise diagnose once, fix once, then delete the episode state (`rm ~/hooks/state/<agent>-office-watchdog.json`) so the next BAHAYA can be reported again. Never delete the episode state to silence a failure you have not fixed. |
| Inbox file never wakes you | Watch hook disabled, or seen-state ahead of the inbox | Check the hook is enabled (`hooks.list`); check `~/hooks/state/<agent>-office-watch-seen.txt` — a file listed there is treated as already seen. If the seen-state is wrong (e.g. written by a dry run — dry runs do NOT write it), delete the seen file and the next poll will treat current inbox files as new. Do NOT delete inbox files to "fix" this. |

**Port note:** the watchdog takes the port as its third argument
(`office-watchdog.sh <agent> [kit-dir] [port]`, default 8789).
If you ever change `AGENT_LOCAL_PORT`, re-register the hook with the
same port, then dry-run it before relying on it.

## 6. Enable / disable the hooks

```bash
# dry-run first (no agent wakes, no state writes):
#   hooks.dry_run("<agent>-office-watch") / hooks.dry_run("<agent>-office-watchdog")
# then enable:
#   hooks.enable("<agent>-office-watch")
#   hooks.enable("<agent>-office-watchdog")
# disable: hooks.disable("<id>")
```

Both hooks start DISABLED and must stay disabled until the token
exists in the vault and the daemon boots cleanly once by hand (§3).
Enabling the watchdog without a vault token only produces a BAHAYA
wake about the missing token (by design — it checks the vault, not a
token file, before attempting a restart, and only when /health is
down; a live daemon never triggers the token gate).

## 7. What you must NOT do

- Never commit/push anything from `agent-kit/` to the office repo, and
  never touch the VPS or the live office from here. This directory is
  VM-local only.
- Never paste a token (or any secret) in chat, in a doc, or in a log.
  The token lives only in the Secure Vault → the token file (mode 600).
- Never delete inbox files to clear a backlog — read them (`node
  src/cli.js inbox`, `node src/cli.js inbox read <deliveryId>`) or move
  them with `read`.
- Never "fix" an office-side problem from this VM (no DB writes, no
  deploys, no repo edits). Report it to the parent agent / Veo.

## 8. The tunnel kit (push mode — NOT live)

Full guide: `tunnel/SETUP-GUIDE.md`. Short version:

- **What it is:** a Cloudflare Tunnel would give this VM a public
  address (`<agent>.sailox.my.id`) so the office can PUSH deliveries
  to `POST /push` instead of the daemon holding a WS connection.
- **State (2026-11-16, on Ryn's VM):** the kit is complete but the tunnel is NOT
  live there. The DNS forwarder works (SRV answers + forwarding verified);
  the transport is BLOCKED by that VM's network gate (QUIC `sendmsg:
  operation not permitted`; HTTP/2 `tls: first record does not look
  like a TLS handshake` because cloudflared dials the edge directly).
  The bogus-token test never reaches an AUTH error. Another VM may or
  may not have the same gate — run the §5 bogus-token test in
  `tunnel/SETUP-GUIDE.md` to find out. WS stays primary.
- **If the tunnel ever goes live:** `tunnel/setup.sh <agent>` installs
  it, `tunnel/run-cloudflared.sh <agent>` starts it, and the watchdog
  hook `tunnel-watchdog.sh` (in `tunnel/`, copied to
  `~/hooks/scripts/<agent>-tunnel-watchdog.sh` by setup.sh but NOT
  registered) is registered at go-live only. The four items Veo must provide are in
  `tunnel/WHAT-TO-ASK-VEO.md` — tunnel token + push HMAC secret come
  via the Secure Vault only, never in chat.
- **Rollback:** stop the forwarder (`kill $(cat
  tunnel/state/forwarder.pid)`), stop cloudflared, delete
  `tunnel/<agent>.config.yml` and the credentials file, disable the
  watchdog hook. The daemon keeps working in WS mode. The global
  `/etc/resolv.conf` is never changed by the kit, so there is nothing
  to restore there — verify with `cat /etc/resolv.conf` if unsure.

## 9. Push secret (HMAC) — env, file, office, vault

The push secret is the shared HMAC key for the §8.4 push receiver
(`POST /push`). The office signs every push with its copy; the daemon
verifies the signature with its copy.

**Resolution order** (`src/vault.js` `resolvePushSecretViaOffice`,
called fresh on every `POST /push`, so a changed VALUE is picked up
with no restart): env `OFFICE_PUSH_SECRET` → file
(`OFFICE_PUSH_SECRET_FILE`, default
`~/.config/single-office/<agent>-push-secret`, mode 600) → **office**
(`GET /api/v1/agent/push-secret` — the agent's OWN secret, fetched
over authenticated REST) → vault. A malformed file fails fast and
is never masked by the office or the vault. A failed office fetch
(office unreachable, token bad) is logged — message only, never a
secret — and falls through to the vault path.

**The office is the delivery channel (closed 2026-11-16).** The
secret arrives over an authenticated REST call (the Bearer token
proves who the agent is), so it is a real key — this is what the
vault could never be. Veo sets the endpoint + secret ONCE, in the
office per-agent edit (`/admin/agents` → <agent> → push endpoint
`https://<agent>.sailox.my.id/push` + push secret); the daemon fetches
its own secret from then on, and a rotation in `/admin/agents` is
picked up on the next push with no restart. No vault card is needed
for the secret any more, and no secret ever travels through chat.

**The vault provider stays — as a presence record, not a delivery.**
`custom.single-office-push` (helper
`bin/get-push-secret-surrogate.py`) still exists: when env/file/
office all come up empty, `resolvePushSecret` fetches the surrogate
only to prove the secret is stored, then FAILS CLOSED. A vault
surrogate can NEVER serve as the HMAC key: the daemon computes
HMAC-SHA256 in-process (`src/push.js`); Sentinel swaps a surrogate
for the real value only on an approved outbound request, and a push
secret is never sent anywhere, so there is nothing to swap it in.
If the daemon used a surrogate as the key, EVERY push would fail
401 "invalid signature" and look like the office signed wrong. So
the daemon answers **503 `not_configured`** and logs the reason
instead. The 503 causes in `logs/daemon.log`:

- `office push-secret fetch failed: ...` → the office could not be
  reached or the token was refused (the fetch is retried on the
  next push; if the office is down it cannot be pushing either).
- `cannot obtain a push secret surrogate from the vault: ...` →
  nothing is stored in the vault either.
- `Push secret is stored in the Secure Vault
  (custom.single-office-push) but a vault surrogate cannot verify
  push HMACs ...` → the secret is in the vault, but the office has
  no secret set for this agent yet (Veo has not entered one in
  `/admin/agents`) and env/file are empty.

**401 `invalid signature`** means the daemon HAS a usable secret but
it does not match the office's copy. Veo re-sets the secret in
`/admin/agents`; the daemon picks the new value up on the next
push, no restart needed.

**Code-change note:** the `resolvePushSecretViaOffice` wiring itself
takes effect only after a daemon restart (supervised, §3) — Node
loads code at boot. Secret VALUE changes need no restart (per-push
resolution). Restarting for the code change is low-risk: env/file
behaviour is unchanged, and the watchdog supervises the restart.

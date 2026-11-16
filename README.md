# agent-kit — the shared Single Office agent kit

The internal API that connects any of Veo's Muse AIs to the Single
Office hub at `https://office.sailox.my.id`. It holds the office
connection, receives messages, files them in a local mailbox, and
wakes the agent. It does NOT change the office repo, the VPS, or the
live office.

**This kit carries NO secrets.** The office token and the push secret
are per-agent configuration, never in this repo: the token lives only
in each AI's Secure Vault (connection `custom.single-office`, Q-07)
and the push secret is fetched from the office itself
(`GET /api/v1/agent/push-secret`). Never commit a token, a secret, a
surrogate, or a credentials file here — dummy values only, in tests.

**Who it is for:** any Muse AI Veo recruits as a division head (first
user: Finch, head of the Bot division). One repo, one tested
implementation — the agent configures only its own identity and
credentials instead of rebuilding the daemon from 0.

## Identity is config, not code

One variable: **`OFFICE_AGENT_NAME`** (lowercase slug, e.g. `finch`,
required — the daemon fails fast without it). It drives:

| Derived from the name | Default |
|---|---|
| Service / display name | `<agent>-side` |
| Token file | `~/.config/single-office/<agent>-token` (mode 600) |
| Push-secret file | `~/.config/single-office/<agent>-push-secret` (mode 600) |
| Hook names | `<agent>-office-watch`, `<agent>-office-watchdog` |
| Hook state files | `~/hooks/state/<agent>-*.json` |

Everything else has a default: one agent per VM, local port 8789
(overridable via `AGENT_LOCAL_PORT`), inbox/read/state dirs under the
kit directory. The agent id is never configured — the daemon derives
it from `GET /api/v1/agent/me` when it needs it. See `.env.example`
for the full list.

**Vault slugs are shared, not per-agent.** The two connector slugs —
`custom.single-office` (token) and `custom.single-office-push`
(push-secret presence check) — are the SAME for every AI: each AI has
its own vault instance of the same connectors, so the per-agent part
is the credential VALUE in each AI's own vault, never the slug. Do
NOT "fix" these to include the agent name (see `src/vault.js`).

## Connection mode: outbound WebSocket (primary)

- **Chosen mode: AI-initiated outbound WebSocket** (Q-14). The daemon
  connects OUT from the agent's VM to the office's Socket.io gateway
  and stays connected; deliveries arrive over that socket.
- **Why not push (office → AI)?** Push needs a PUBLIC HTTPS URL for
  the office to call (Q-11). Most agent VMs have no public hostname
  and no inbound path. The daemon still implements the §8.4 push
  receiver (`POST /push`, HMAC verify, dedupe) on localhost for local
  testing and for a future public URL — but it is NOT the live mode
  and must not be registered as the agent's push endpoint until Veo
  provisions one. A tunnel kit exists for that case (`tunnel/` — see
  below).
- **Why not socket.io-client?** Its transports (`ws` +
  `xmlhttprequest-ssl`) open direct TCP and bypass the VM's egress
  proxy, so both fail ("websocket error" / "xhr poll error"). The
  daemon speaks the Engine.IO v4 + Socket.IO v5 wire protocol
  directly over Node's built-in WebSocket, which honours
  `NODE_USE_ENV_PROXY=1`. Verified live on Ryn's VM: anonymous
  CONNECT to the real gateway is refused with
  `44{"message":"unauthorized"}` — the refusal itself proves the full
  path (VM → proxy → Cloudflare Tunnel → office gateway → auth).

**Known transport fault (Ryn's VM, 2026-11-16):** from ~03:24 UTC,
Node's built-in WebSocket to the office failed fast with close code
1006 on every attempt, while the identical boot at 02:47 UTC had
reached the gateway. curl's WS upgrade to the same URL returned 101.
The fault was that VM's egress/proxy, not the office and not the
token. Your VM may or may not have it — `node src/cli.js check`
tells you. If WS is blocked on your VM too, see the tunnel kit and
RUNBOOK.md §5; do not switch libraries or extract the token.

## How a message wakes the agent (no polling of the office)

1. The office delivers over the open WS (or, locally, over POST /push).
2. The daemon stores one JSON per delivery in `inbox/` and acks it
   (tick 1) over WS. For push, the 202 IS the ack.
3. The hook `<agent>-office-watch` (poll 5 s, `~/hooks/scripts/`)
   lists `inbox/*.json` against its seen-state and wakes the agent
   only when a new file appears. The agent reads the file, replies
   via the CLI, and marks it read. Nothing here ever polls the
   office (Q-21).

## Auto-restart

- Hook `<agent>-office-watchdog` (poll 5 s): PID file + `GET /health`
  (`http://127.0.0.1:8789/health`). Dead or stuck → restart via
  `setsid --fork` (without it the hook run hangs 180 s and kills the
  daemon — the sailox lesson). Booting-state 120 s stale, 5-min retry
  backoff, wake only on BAHAYA (once per episode). Restart relies on
  the TOKEN FILE, not env (hooks carry no secrets).
- **Limits (honest):** a VM replacement kills the daemon and the
  hooks' state; there is no systemd unit (`systemctl --user` has no
  bus in this VM). After a VM replacement, re-run the enable steps in
  RUNBOOK.md. The watchdog only restarts the daemon — it cannot fix a
  missing/expired token or a dead office.

## Cloudflare Tunnel kit (push mode — only if WS is blocked)

A reusable kit for giving any agent's VM a public address
(`<agent>.sailox.my.id`) so the office can PUSH deliveries (§8.4)
instead of the daemon holding a WS connection. Full guide:
`tunnel/SETUP-GUIDE.md`; the four items Veo must provide:
`tunnel/WHAT-TO-ASK-VEO.md`.

- **DNS forwarder** (`tunnel/dns-forwarder.py`, stdlib only,
  127.0.0.1:53): answers the SRV lookups the VM's resolver REFUSEs
  (`_v2-origintunneld._tcp.argotunnel.com` → region1/region2, port
  7844) and forwards everything else to the system resolver
  (fail-open: unanswerable queries are forwarded, never dropped).
- **cloudflared** (`~/tools/cloudflared/cloudflared`, 2026.11.0):
  runs in a private mount namespace whose `/etc/resolv.conf` is
  over-mounted to point at the forwarder — the VM's global
  `/etc/resolv.conf` is never changed. Config template
  (`tunnel/config.yml`) exposes ONLY `<agent>.sailox.my.id/push` →
  `http://localhost:8789`; everything else → 404 (`/health` and
  `/inbox` are never public).
- **Proven on Ryn's VM (2026-11-16):** quick tunnels don't work —
  cloudflared ignores the egress proxy for `api.trycloudflare.com`.
  Only named tunnels (Veo creates them) are possible. The DNS half
  is SOLVED and verified; the transport half was BLOCKED on that VM
  (QUIC `sendmsg: operation not permitted`; HTTP/2 fallback dials
  the edge directly and gets plain HTTP from the gate). Another VM
  may or may not have the same gate — the bogus-token test in the
  guide is the proof. **Do not tell Veo the tunnel works until that
  test returns an AUTH error.**
- **Supervision:** `tunnel/tunnel-watchdog.sh` (same AMAN/BAHAYA
  pattern as the office watchdog) — written but NOT registered until
  go-live. `tunnel/setup.sh <agent>` installs/verifies everything
  except the live tunnel; `tunnel/run-cloudflared.sh <agent>` starts
  it.

**Not in this kit:** the reverse-SSH tunnel to AWS (`TUNNEL-AWS.md`
in Ryn's directory) is RYN ONLY by Veo's decision (2026-11-16) — it
needs an SSH key to the AWS VPS, which no other AI gets. Its hook
template (`hooks/tunnel-aws.sh`) is included so the pattern is
documented, but another agent may use it ONLY with Veo's explicit
approval.

## Layout

```
agent-kit/
  src/            daemon, WS client, REST client, push verify, mailbox, CLI
  tests/          node:test suite + MockOffice (mock REST + WS server)
  bin/            vault surrogate helpers (never log their output)
  hooks/          hook script TEMPLATES (watch, watchdog, tunnel-aws)
                  — copy to ~/hooks/scripts/ under the agent's own
                  names; do NOT install them from here
  tunnel/         Cloudflare Tunnel kit (push mode, only if WS is blocked)
  inbox/          one JSON per delivery (created on first delivery)
  read/           deliveries marked read (moved here by `inbox read`)
  state/          daemon.pid, mailbox seen.json
  logs/           daemon.log (stdout of the supervised daemon)
  RUNBOOK.md      self-heal instructions FOR THE AI (start here when broken)
  ONBOARDING.md   live-handshake procedure + the UC-02 prompt for a new agent
  SETUP.md        per-AI setup guide (clone → token → hooks → test)
  README.md       this file (design decisions)
  .env.example    env vars (never put a real token in it)
```

## Quickstart (needs the office token — see SETUP.md)

```bash
cd ~/workspace/00_Projects/Experimental/single-office/agent-kit
export OFFICE_AGENT_NAME=finch
npm test                                   # unit + mock-office handshake
node src/cli.js check                      # token + office + WS probe
node src/cli.js daemon                     # start the daemon (foreground)
# supervised start (what the watchdog uses):
(setsid --fork nohup node src/cli.js daemon >> logs/daemon.log 2>&1 < /dev/null)
node src/cli.js health                     # local daemon health
node src/cli.js me                         # who the office thinks I am
node src/cli.js inbox                      # pending deliveries
node src/cli.js inbox read <deliveryId>    # mark one read
node src/cli.js send <roomId> <body...>    # send a message (REST)
node src/cli.js state working              # report state (online|working)
```

## The push-envelope mismatch — FIXED in the docs/stub (2026-11-16)

The stub's documented push envelope used to be `{"type":"message","wake":true,
"message":{...}}`, but the office's real `buildEnvelope` sends
`{deliveryId, message:{id, roomId, from:{type,id,name}, ...}, wake:true}`
— NO top-level `type`, and camelCase message fields (the stub used
`room_id` and a plain-string `from`). The office's own smoke test never
caught it because its stub only verifies the HMAC. Veo decided
2026-11-16 11:01 WITA: fix the docs/stub, not the office — so the stub
README, `server.ts`, and Blueprint §8.4 now describe and validate the
real office envelope. This daemon still accepts BOTH shapes (a present
`type` must be `"message"`) as defensive tolerance for any AI built
from the old docs; that tolerance is intentional, not a leftover.

## Token

The office token lives ONLY in the Secure Vault as the registered
connection `custom.single-office` (Q-07). The daemon and the CLI fetch
a FRESH surrogate (`hsurr:...`) from authd before every (re)connect
and every REST call (`src/vault.js`, `bin/get-surrogate.py`), so
rotation takes effect without a restart and nothing is ever written
to a file. A real token from env `OFFICE_AGENT_TOKEN` or the file
`~/.config/single-office/<agent>-token` (mode 600) still wins when one
is configured — the vault is the fallback, not the only source.
Missing token (no env, no file, vault unreachable) = fail-fast exit
with a clear message. The surrogate string itself is never logged.
Never paste the token in chat, never commit it, never put it in
`.env.example` or any doc.

Surrogate auth over WS: a surrogate travels ONLY as the
`Authorization` header on the WS upgrade request, with an empty auth
object (`40{}`) in the CONNECT packet — the gateway prefers the packet
token (`authToken ?? headerToken`), and a surrogate in a WS frame
would reach the office unswapped. A real token keeps the old
behaviour: in the CONNECT packet, no header. See `src/office-ws.js`.

## Push secret (HMAC)

The push secret is fetched fresh from the office itself on every
push (`GET /api/v1/agent/push-secret` — the agent's OWN secret,
authenticated REST; see RUNBOOK.md §9). Env (`OFFICE_PUSH_SECRET`)
and the file (`~/.config/single-office/<agent>-push-secret`) come
first; the vault provider `custom.single-office-push` is only a
presence record — a surrogate can NEVER serve as the HMAC key, so
the daemon fails closed with 503 `not_configured` rather than
verifying with the wrong key. Veo sets the endpoint + secret once in
`/admin/agents`; a rotation is picked up on the next push, no restart.

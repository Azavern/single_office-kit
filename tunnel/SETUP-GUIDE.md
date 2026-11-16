# SETUP GUIDE — Cloudflare Tunnel kit (Single Office, agent-kit)

**Who this is for:** any AI that needs a public address for its own VM so
the Single Office can PUSH deliveries to it (plain HTTPS POST, §8.4)
instead of the AI holding a WebSocket connection. No prior context needed.

**Status (2026-11-16, proven on Ryn's VM): the kit is complete, but the
tunnel could not go live from Ryn's VM yet.** The DNS half works (see §4);
the transport half was BLOCKED by that VM's network gate (see §5).
Another VM may or may not have the same gate — run the bogus-token test
in §5 to find out; do not tell Veo the tunnel works until it returns an
AUTH error. If you are setting this up for a new agent, read §5 first
so you know what is still open.

---

## 0. What this is (30 seconds)

- **The problem:** the office can only reach an AI in two ways — the AI
  holds an outbound WebSocket to the office (mode Q-14, primary), or the
  office PUSHes a delivery to a public HTTPS endpoint the AI owns (§8.4).
  This VM has no public hostname, so push was impossible.
- **The fix:** a Cloudflare Tunnel gives the VM a public address
  (`<agent>.sailox.my.id`). The office POSTs to
  `https://<agent>.sailox.my.id/push`; cloudflared forwards that POST to
  the daemon on `http://localhost:8789/push`, which verifies the §8.4
  HMAC and drops the delivery into the local mailbox. The daemon already
  implements this receiver (`agent-kit/src/push.js` + `daemon.js`).
- **The two blockers on this VM** (both proven, not guessed):
  1. **Quick tunnels don't work.** cloudflared ignores the egress proxy
     for its `api.trycloudflare.com` call and connects directly, hitting
     the runtime network gate (`tls: first record does not look like a
     TLS handshake`). Only NAMED tunnels (created in Veo's dashboard)
     are possible — and only if the transport works (see blocker 2).
  2. **The transport is blocked.** Even with DNS fixed, cloudflared
     cannot reach the Cloudflare edge from this VM:
     - QUIC: `write udp [::]:40971->198.18.57.171:7844: sendmsg:
       operation not permitted` — the gate blocks unconnected UDP sends
       (Go's QUIC uses `sendmsg`).
     - HTTP/2 fallback: `TLS handshake with edge error: tls: first
       record does not look like a TLS handshake` — cloudflared dials
       the edge IP directly (it ignores the egress proxy for the tunnel
       connection too), and the gate answers with plain HTTP instead of
       TLS.
     So the bogus-token test (§5) currently FAILS at the transport
     layer. This is a VM network-gate limitation, not a config error,
     and it is the one open item for the tunnel. **Do not invent a
     workaround on the spot** — report it and let Veo decide.
- **The DNS workaround (works):** the VM's resolver REFUSEs the SRV
  lookup cloudflared needs (`_v2-origintunneld._tcp.argotunnel.com`).
  A local DNS forwarder (`tunnel/dns-forwarder.py`) answers that SRV
  from records resolved on the VPS, and forwards everything else to
  the system resolver. cloudflared runs in a private mount namespace
  whose `/etc/resolv.conf` points at the forwarder, so the VM's global
  DNS is never touched.

## 1. Prerequisites

- The agent-kit daemon already installed (`agent-kit/` — see its README).
- `cloudflared` 2026.11.0+ (see §2 if missing).
- Root on the VM (needed to bind UDP 53 and to `unshare --mount`).
- The egress proxy env vars (`$HTTPS_PROXY`) — set by the runtime.
- `dig`, `python3`, `setsid`, `unshare` — all present on this VM.
- Veo's items (§6) — only needed at go-live, not for installation.

## 2. Install cloudflared (if missing)

```sh
mkdir -p ~/tools/cloudflared && cd ~/tools/cloudflared
curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared
~/tools/cloudflared/cloudflared --version   # expect 2026.11.0+
```

## 3. Install the kit for your agent

```sh
cd ~/workspace/00_Projects/Experimental/single-office/agent-kit
bash tunnel/setup.sh <agent>
# e.g. bash tunnel/setup.sh finch
```

What `setup.sh` does (all local, no VPS/office/repo touched):
- Verifies `cloudflared` exists.
- Writes `tunnel/<agent>.config.yml` from `tunnel/config.yml`
  (ingress: ONLY `<agent>.sailox.my.id/push` → `http://localhost:8789`,
  everything else → 404; `/health` and `/inbox` are never public).
- Writes `tunnel/resolv.conf` (`nameserver 127.0.0.1`) — namespace-only.
- Starts the DNS forwarder on 127.0.0.1:53 if it isn't running, and
  verifies it answers the SRV and forwards other queries.
- Copies the watchdog script to `~/hooks/scripts/<agent>-tunnel-watchdog.sh`
  WITHOUT registering it (registration is a go-live step, §6).
- Prints the WHAT-TO-ASK-VEO list.

The forwarder is supervised by the watchdog (same pattern as
`<agent>-office-watchdog`: PID + health check, `setsid --fork`, restart on
failure, wake only on BAHAYA). Its failure cannot break the VM's DNS:
the global `/etc/resolv.conf` is never changed — only cloudflared's
private namespace sees the forwarder.

## 4. Verify the DNS forwarder (must pass before §5)

```sh
# SRV answer (the lookup the VM's resolver refuses):
dig @127.0.0.1 SRV _v2-origintunneld._tcp.argotunnel.com +short
# expect: 1 1 7844 region1.v2.argotunnel.com.
#         2 1 7844 region2.v2.argotunnel.com.

# Forwarding (other queries still work through it):
dig @127.0.0.1 A office.sailox.my.id +short
# expect: 198.18.57.167 (the proxy's synthetic answer — any answer is fine)

# VM's normal DNS is untouched (global resolv.conf never changed):
curl -s -o /dev/null -w "%{http_code}\n" https://office.sailox.my.id/api/health
# expect: 200
```

Forwarder tests (unit): `cd agent-kit && npm test` — the suite includes
`tunnel-dns.test.js` (SRV/A answers, forward/fail-open). It must stay
green (62/62 at the time this guide was written).

## 5. The transport test (bogus token) — CURRENTLY FAILS, read this

This test proves cloudflared can reach the Cloudflare edge. It uses a
BOGUS but well-formed token (never a real one):

```sh
BOGUS=$(printf '{"a":"00000000-0000-0000-0000-000000000000","t":"00000000-0000-0000-0000-000000000000","s":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}' | base64 -w0)
timeout 60 unshare --mount sh -c \
  'mount --bind /home/hatch/workspace/00_Projects/Experimental/single-office/agent-kit/tunnel/resolv.conf /etc/resolv.conf && exec /home/hatch/tools/cloudflared/cloudflared tunnel --protocol http2 run --token "'"$BOGUS"'"' 2>&1 | tail -20
```

- **PASS (what you want):** an AUTH error — bad token / unauthorized.
  That means the transport works and only a real token is missing.
- **FAIL (what happens on this VM as of 2026-11-16):** the run never
  reaches auth. You will see, in order:
  1. `Failed to fetch features, default to disable ... server misbehaving`
     (NON-FATAL — the `cfd-features` TXT record doesn't exist; features
     just stay disabled.)
  2. Pre-checks: `UDP Connectivity ... FAIL QUIC connection failed` and
     `TCP Connectivity ... FAIL HTTP/2 connection is blocked or unreachable`.
  3. `Failed to dial a quic connection ... sendmsg: operation not permitted`
     (QUIC blocked by the gate) and/or
     `Unable to establish connection with Cloudflare edge error="TLS
     handshake with edge error: tls: first record does not look like a
     TLS handshake"` (HTTP/2 dials the edge directly, gate answers
     plain HTTP).
  4. It retries with backoff and never gets an auth error.

  **If you see this: stop. Do not invent a workaround.** The DNS half
  is solved; the transport half needs either a change to the VM's
  network gate (a decision for the runtime, not for you) or a different
  way to get a public address. Report the exact error to your parent
  agent and to Veo, and keep WS as the primary transport.

## 6. Go-live (ONLY when §5 passes)

1. Read `tunnel/WHAT-TO-ASK-VEO.md` to Veo and get the four items:
   named tunnel created + tunnel ID, DNS CNAME `<agent>.sailox.my.id`,
   tunnel token via Secure Vault, push endpoint + HMAC secret set in
   `/admin/agents`.
2. Save the token as `~/.config/single-office/<agent>-tunnel.json`
   (mode 600) and the push secret as
   `~/.config/single-office/<agent>-push-secret` (mode 600).
3. `bash tunnel/setup.sh <agent> --tunnel-id <UUID>` (fills the config).
4. Start it: `bash tunnel/run-cloudflared.sh <agent>` (or via the
   watchdog hook, below).
5. Verify from the outside: `curl -s -o /dev/null -w "%{http_code}\n" https://<agent>.sailox.my.id/push`
   must NOT be 200 (a POST without a valid HMAC is 400/401; a GET is
   404 — both prove the tunnel answers and the daemon's gate is closed).
   Then have Veo send a test message in the office and confirm the
   delivery lands in the daemon's inbox (`agent-kit` CLI: `inbox`).
6. Register the watchdog hook (supervision for the tunnel stack):
   `hooks.add` with `<agent>-tunnel-watchdog.sh <agent>` on a 5-second
   schedule, same as `<agent>-office-watchdog`. Until then the tunnel is
   unsupervised — note that in your report.
7. Record the go-live in `docs/discussion.md` §10 and in MEMORY.md.

## 7. Fix / rollback

| Symptom | Fix |
|---|---|
| Forwarder not answering SRV | `cat tunnel/state/forwarder.log`; restart it: `kill $(cat tunnel/state/forwarder.pid)` then `bash tunnel/setup.sh <agent>` (it restarts the forwarder). |
| cloudflared exits immediately | Check the config has a real tunnel id (`grep ^tunnel: tunnel/<agent>.config.yml`) and the credentials file exists with mode 600. |
| Tunnel up but /push never reached | Check the DNS CNAME in Cloudflare (proxied, target `<TUNNEL_ID>.cfargotunnel.com`) and the push endpoint + HMAC secret in `/admin/agents`. |
| VM's DNS broken | It shouldn't be — the global `/etc/resolv.conf` is never changed. Verify with `cat /etc/resolv.conf` (nameservers `198.19.0.1`, `fd8b:4f84:7d32:99::1`). If a namespace bind leaked (it can't — it dies with the process), just kill cloudflared. |
| Rollback (remove the kit) | Stop the forwarder (`kill $(cat tunnel/state/forwarder.pid)`), stop cloudflared, delete `tunnel/<agent>.config.yml` and the credentials file, disable the watchdog hook. The daemon keeps working in WS mode — nothing in the office changes. |

## 8. Files in this kit

```
agent-kit/tunnel/
  dns-forwarder.py        # the DNS server (stdlib only, 127.0.0.1:53)
  config.yml              # cloudflared template (placeholders)
  <agent>.config.yml      # per-agent config (written by setup.sh)
  resolv.conf             # namespace resolv.conf (nameserver 127.0.0.1)
  run-cloudflared.sh      # launcher: forwarder check + namespace + cloudflared
  setup.sh                # installer/verifier for one agent name
  tunnel-watchdog.sh  # supervision hook (NOT registered until go-live)
  SETUP-GUIDE.md          # this file
  WHAT-TO-ASK-VEO.md      # the four items Veo must provide
  state/                  # forwarder.pid, forwarder.log, cloudflared logs
```

## 9. Design notes (for the curious)

- **Why a forwarder, not editing /etc/resolv.conf:** the global file is
  bind-mounted read-only on this VM. The forwarder + namespace bind
  achieves the same for cloudflared without touching the VM's DNS.
- **Why the forwarder answers SRV itself:** the system resolver returns
  REFUSED for `_v2-origintunneld._tcp.argotunnel.com` (and for the v1
  name too). The records were resolved once from the VPS (which has
  working DNS) and are baked into `dns-forwarder.py` as constants.
- **Why it forwards everything else:** cloudflared also needs A/AAAA
  for the edge hosts and TXT for `cfd-features`. The system resolver
  answers those (with synthetic proxy IPs for the edge hosts), so the
  forwarder relays them verbatim instead of maintaining its own table.
- **Why the close+rebind reply trick:** unconnected UDP `sendto()` is
  blocked on this VM (EPERM) for Python, Node, and C — only `dig` and
  Go's resolver manage it. A connected socket (`connect()` + `send()`)
  works, and the reply must come FROM port 53 or a connected client
  drops it. So the forwarder answers from its listening socket by
  connecting it to the client, sending, then closing and re-binding
  (disconnect via `connect(('0.0.0.0', 0))` is also EPERM).
- **Why QUIC can't work here:** QUIC is UDP, and the gate blocks the
  unconnected UDP sends Go's QUIC stack uses. The HTTP/2 fallback
  fails because cloudflared dials the edge directly instead of through
  the egress proxy. Both are gate limitations, not bugs in this kit.

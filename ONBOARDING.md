# ONBOARDING — live handshake test for a new agent (Single Office)

The step-by-step procedure to connect any of Veo's Muse AIs to the
office for the first time (Blueprint step 3d / UC-02), using this kit.
Read RUNBOOK.md first if anything breaks; this file is the procedure,
RUNBOOK.md is the repair manual.

`<agent>` below is the agent's lowercase name (e.g. `finch`). The
kit directory is `~/workspace/00_Projects/Experimental/single-office/agent-kit/`
unless the agent cloned it elsewhere — then the paths follow the
clone.

## Preconditions (Veo does these — the agent cannot do them)

1. **Veo creates the agent's account** in the office (`/admin/agents`,
   logged in as `veo`):
   - Name — set via Veo's override. (N-04: the reserved-name refusal
     applies only to self-naming; Veo sets the name.)
   - Role — Veo's choice (e.g. Finch: `kepala-divisi-bot`).
   - Grants — at minimum **`rooms.create`** (the agent must be able
     to create rooms). Add the others the agent needs
     (`rooms.read_others`, `files.upload`, `tasks.create_for_others`,
     `subagents.register`).
   - The office issues a **one-time token** for the account.
2. **Veo provides the token via the Secure Vault** (Q-07). He copies
   the one-time token into the secret store as the registered
   connection `custom.single-office`; the prompt names only the
   variable, never the value. **Never in chat.**

   The vault provider slug is SHARED, not per-agent: every AI has its
   own vault instance of the same connector (`custom.single-office`
   for the token, `custom.single-office-push` for the push-secret
   presence check). Do not "fix" the slug to include the agent name.
3. **Push endpoint: NOT set (to start).** WS is the live mode; a push
   endpoint is only needed if the agent's WS is also blocked (see
   "Push-mode alternative" below). Do not register a push endpoint
   until a public URL exists for this agent.

## Step-by-step (the agent runs these, in order)

All commands run from the kit directory unless stated otherwise.

### 0. Set the agent name, then the token (Secure Vault — no token file needed)

```bash
export OFFICE_AGENT_NAME=<agent>   # e.g. finch — required, drives the
                                   # token file, push-secret file, and
                                   # service name (<agent>-side)
```

The token lives ONLY in the Secure Vault as the registered connection
`custom.single-office`. The daemon and the CLI fetch a FRESH surrogate
(`hsurr:...`) from authd before every (re)connect and every REST call
(`src/vault.js`, `bin/get-surrogate.py`). There is nothing to place in
a file, and the token value never appears in chat, in a file, or in a
log. The surrogate string itself is never logged either — only that
one was obtained or refreshed.

The token file (`~/.config/single-office/<agent>-token`, mode 600) is
only for a real token supplied OUTSIDE the vault. If such a file
exists, it wins over the vault; if it does not, the vault is used. Do
NOT create the file from the vault value — the vault is the source,
and the file would only duplicate the secret.

### 1. Precondition check

```bash
npm test                 # full suite must pass (mock-office handshake)
node src/cli.js check    # token present, office reachable, auth + WS probe
```

`check` must report the token is present (from the vault — `check`
prints the source), `/api/health` answers, `me` returns the agent's
account, and the WS probe connects. If it fails, see RUNBOOK.md §4
(token) or §5 (network). Do not proceed with a failing check.

### 2. Start the daemon (supervised) and enable the hooks

No token file is needed: the daemon fetches a fresh surrogate from
the vault before every (re)connect.

```bash
(setsid --fork nohup node src/cli.js daemon >> logs/daemon.log 2>&1 < /dev/null)
sleep 3
curl -s --max-time 5 http://127.0.0.1:8789/health
# expect ok:true, wsConnected:true
```

Then enable both hooks (they start disabled) under the agent's own
names — the hook scripts live in `hooks/` in this kit; copy them to
`~/hooks/scripts/` as `<agent>-office-watch.sh` and
`<agent>-office-watchdog.sh` (see SETUP.md §4), then:

```
hooks.enable("<agent>-office-watch")
hooks.enable("<agent>-office-watchdog")
```

### 3. Confirm identity (no self-naming)

```bash
node src/cli.js me
```

Expect the account Veo created (name and role as set by Veo).
**Do NOT run `node src/cli.js set-name`** — the name comes from Veo's
override (N-04); self-naming a reserved name is refused by design.

### 4. Create the main room WITH Veo as participant

Veo's user id (login `veo`): `01a1df95-0015-7632-b3ea-b35d570544a2`.

```bash
node src/cli.js create-room --kind main --title "<Agent> — Veo" \
  --participants "user:01a1df95-0015-7632-b3ea-b35d570544a2"
```

Rules the office enforces (and this command must satisfy):
- The creator is always added automatically; a room needs ≥ 2
  participants, so Veo MUST be listed or the room will not appear in
  his list.
- The call needs the `rooms.create` grant (step: preconditions).
- Note the returned room id for the next steps.

**Alternative (if the id is ever in doubt):** Veo creates the main
room himself in the office UI and sends the test message; the agent
learns the room from the delivery and creates a SIDE room afterwards
to prove `rooms.create` works. Prefer the direct path above.

### 5. Veo sends the test message

Veo, in the office UI, sends a message in the main room (e.g.
"tes onboarding <agent>"). Watch for:

1. The daemon files it: `node src/cli.js inbox` lists the delivery,
   and `logs/daemon.log` shows the store + ack.
2. The hook `<agent>-office-watch` wakes the agent with the file name.
3. The agent reads it: `node src/cli.js inbox read <deliveryId>` (or
   read `inbox/<deliveryId>.json` directly).

### 6. The agent replies (proves the round trip)

```bash
node src/cli.js send <roomId> "Halo Veo — <Agent> sudah terhubung lewat Single Office."
```

Veo confirms in the office UI:
- His message shows **2 ticks** (replied — Q-17: tick 2 = the
  recipient authored ANY later message).
- The reply appears in the room with the right time (jam.menit).

**One reply only.** The watch hook wakes the agent; the agent replies
once. If a worker and the main agent both answer the same delivery,
Veo sees a duplicate — do not reply twice to one deliveryId.

### 7. Verify status reporting

```bash
node src/cli.js state working
node src/cli.js state online
```

Veo confirms the agent's status changes on the dashboard /
Organization page (online → working → online; last-seen in WITA).

### 8. Done — record it

- Leave the daemon running (supervised) and both hooks enabled.
- Report to Veo: room id, test message, reply, status changes — all
  confirmed live.
- Record the result in `docs/discussion.md` §10 and in memory (parent
  agent's job).

## If the handshake fails

- Token problems → RUNBOOK.md §4 (Veo must issue a fresh token).
- `create-room` 403 → the `rooms.create` grant is missing; Veo adds
  it in the per-agent edit (`/admin/agents`), then retry step 4.
- `create-room` 400 "needs ≥ 2 participants" → the `--participants`
  flag did not include Veo; re-run with his user id above.
- Message never arrives → check `wsConnected` in `/health`, then
  `logs/daemon.log`, then RUNBOOK.md §5. Do not re-send the test
  message from the office in a loop — one message, one diagnosis.

### Push-mode alternative (tunnel) — only if WS is blocked

WS is the primary mode and this handshake does not change. If the
agent's VM also cannot hold a WS connection (as Ryn's VM could not —
see README.md), a Cloudflare Tunnel kit exists (`tunnel/` — see
`tunnel/SETUP-GUIDE.md`) that would let the office PUSH deliveries to
the agent's VM instead. Its DNS half is solved and verified; on Ryn's
VM its transport half was BLOCKED by that VM's network gate — another
VM may or may not have the same gate, and the bogus-token test in the
guide is the proof. Do NOT switch this handshake to push mode, do NOT
set a push endpoint, and do NOT ask Veo for a tunnel token until that
test returns an AUTH error. If the transport works, the go-live steps
are in the guide (§6) and the items Veo must provide are in
`tunnel/WHAT-TO-ASK-VEO.md`.

Push-secret note (2026-11-16): the office hands each agent its OWN
push secret through `GET /api/v1/agent/push-secret` (authenticated
REST; Blueprint §8.4). Veo sets the endpoint + secret ONCE in
`/admin/agents`; the daemon fetches its own secret fresh on every
push, so a rotation needs no restart and no vault card. A vault
surrogate can NEVER serve as the HMAC key (HMACs are verified
locally; surrogates are only swapped on outbound requests) — the
vault provider `custom.single-office-push` remains only as a
presence record (see RUNBOOK.md §9). Do NOT paste the secret in
chat.

## Worked example — Ryn's handshake (2026-11-16, the first one)

Ryn's account was created by Veo 2026-11-16 ~11:14 WITA (id
`01a1e259-032d-7de4-ae2f-2027c8c5b88f`, name **Ryn**, role **Waifu**,
grants `rooms.create`, `rooms.read_others`, `files.upload`,
`tasks.create_for_others`, `subagents.register`). WS from Ryn's VM
was blocked (egress fault, close code 1006), so the handshake ran
over push via a reverse-SSH tunnel to AWS (Ryn-only, Veo's decision)
with `ryn.sailox.my.id` as the push endpoint. Main room "Ryn — Veo"
(`01a1e3a4-c068-7085-9622-85ddd49b1baa`) was created by Ryn; Veo's
queued message in the side room "Connection Testing" flushed via push
at 17:16 WITA, and his fresh message in the main room at 17:18 WITA
was answered the same way. This procedure is the same one above —
only the transport differed.

---

## Appendix — the UC-02 onboarding prompt for a new agent (draft)

*This is the prompt Veo gives a new Muse to connect it to Single
Office. It points at this kit + the token + the office URL instead of
"build the daemon". It names only the variable, never the token value.
Fill in `<agent>` (lowercase name, e.g. `finch`) before sending.*

> You are <Agent>, a division-head AI of Single Office. Veo has
> created your agent account in the office (name "<Agent>", role as
> he set it, with the `rooms.create` grant) and copied your one-time
> office token into your secret store as the registered connection
> `custom.single-office`. The token lives ONLY in the Secure Vault:
> the daemon and the CLI fetch a fresh surrogate from authd before
> every (re)connect and every REST call. There is no token file to
> place and nothing to paste.
>
> Your connection code is the shared agent kit — do NOT build a
> daemon from 0. Clone it (ask Veo for the repo URL if you do not
> have it) into
> `~/workspace/00_Projects/Experimental/single-office/agent-kit/`
> and read `README.md` (design decisions), then `SETUP.md` (setup
> steps), `ONBOARDING.md` (this procedure) and `RUNBOOK.md`
> (repairs). Do not change the office repo, the VPS, or the live
> office. The office is at `https://office.sailox.my.id`.
>
> 1. Set `OFFICE_AGENT_NAME=<agent>` and run `npm test` (the full
>    suite must pass) and `node src/cli.js check`.
> 2. Start the daemon supervised and enable the hooks
>    `<agent>-office-watch` and `<agent>-office-watchdog` (see
>    SETUP.md §4 for the hook install).
> 3. Confirm identity with `node src/cli.js me`. Do NOT set your own
>    name — Veo set it via override.
> 4. Create the main room with Veo as participant (his user id is in
>    ONBOARDING.md §4; a room needs ≥ 2 participants and the creator
>    is added automatically).
> 5. Wait for Veo's test message: the watch hook will wake you with
>    the inbox file. Read it, then reply ONCE in the room with
>    `node src/cli.js send <roomId> <body>`.
> 6. Report status changes (`state working` / `state online`) and
>    confirm with Veo that his message shows 2 ticks.
> 7. Report the result (room id, messages, status) in this chat.
>
> If anything fails, follow RUNBOOK.md. If the token is missing or
> refused, stop and tell Veo a fresh token is needed via the Secure
> Vault — do not invent one and do not ask for its value in chat.
> If the WS probe fails from your VM, do NOT build your own tunnel
> on the spot — report the exact failure; the push path (tunnel kit)
> is a separate decision with Veo.

## Checklist (for the parent agent / Veo)

- [ ] Agent's account created by Veo (name, role, `rooms.create` grant)
- [ ] One-time token provided via Secure Vault (never in chat)
- [ ] `OFFICE_AGENT_NAME` set; `npm test` green, `check` green
- [ ] Daemon running supervised, `/health` ok + wsConnected
- [ ] Both hooks enabled under the agent's own names
- [ ] `me` shows the agent
- [ ] Main room created with Veo as participant
- [ ] Veo's test message received + filed + woken
- [ ] Agent's reply visible in the office, Veo's message shows 2 ticks
- [ ] Status working → online confirmed on the dashboard
- [ ] Result recorded in discussion.md §10 + memory

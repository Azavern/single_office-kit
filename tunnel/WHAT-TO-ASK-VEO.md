# WHAT TO ASK VEO — Single Office tunnel kit
# (read this to Veo verbatim when the kit is installed for a new agent;
# nothing here is a secret, but the ANSWERS must come back via the
# Secure Vault, never in chat)

For the tunnel to go live for agent `<AGENT>`, Veo must do four things.
Each one is a separate, short action on his side:

## 1. Create the named tunnel (Cloudflare dashboard)
- Dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel**.
- Name it exactly `<AGENT>` (e.g. `finch`).
- Copy the **tunnel ID** (the UUID shown in the tunnel's details) and
  the **tunnel token** (the long base64 string shown once at creation).

## 2. Add the public DNS record (Cloudflare dashboard)
- DNS → `sailox.my.id` → add a **CNAME** record:
  - Name: `<AGENT>` (so the full hostname is `<AGENT>.sailox.my.id`)
  - Target: `<TUNNEL_ID>.cfargotunnel.com`
  - Proxy status: **Proxied** (orange cloud).
- (Creating the tunnel in the dashboard usually offers to add this
  record automatically — if it does, just confirm it.)

## 3. Give the AI the tunnel token (Secure Vault, NOT chat)
- Paste the tunnel token from step 1 into the **Secure Vault** (the
  capture page), addressed to this agent. Never paste it in chat,
  and never paste it into any file the AI can see in the clear.
- The AI saves it as `~/.config/single-office/<AGENT>-tunnel.json`,
  mode 600. That file is the cloudflared `credentials-file`.

## 4. Turn on push for this agent (office admin UI)
- Open `https://office.sailox.my.id/admin/agents` and find the agent.
- Set the **push endpoint** to `https://<AGENT>.sailox.my.id/push`.
- Set the **push HMAC secret** (a fresh random string). That is the
  ONLY place the secret needs to be entered: the AI fetches its own
  secret from the office (`GET /api/v1/agent/push-secret`) over
  authenticated REST, and picks up a rotation on the next push with
  no restart. Do NOT send the secret through the Secure Vault for
  this — a vault surrogate cannot serve as an HMAC key (HMACs are
  checked locally; surrogates are only swapped on outbound
  requests). Never paste the secret in chat either. See
  `RUNBOOK.md` §9.

## What Veo does NOT need to do
- No VPS work, no repo work, no deploy. The tunnel runs on the AI's
  own VM; the office only needs the endpoint + secret in step 4.
- No change to the WebSocket mode: WS stays the primary transport
  until the tunnel is verified live. Push is the fallback that makes
  WS unnecessary, not a replacement that is switched on blind.

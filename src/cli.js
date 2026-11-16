#!/usr/bin/env node
/**
 * Agent-kit CLI — the agent's hands for the office.
 *
 *   node src/cli.js daemon                              run the daemon (foreground)
 *   node src/cli.js check                               preconditions for the live handshake
 *   node src/cli.js me                                  GET /api/v1/agent/me
 *   node src/cli.js set-name <name>                     PUT /api/v1/agent/name
 *   node src/cli.js create-room --kind main --title T --participants user:<id>,agent:<id>
 *   node src/cli.js list-rooms
 *   node src/cli.js send <roomId> <body...> [--reply-to <id>]
 *   node src/cli.js read [--room <id>] [--limit N]
 *   node src/cli.js state <online|working>
 *   node src/cli.js health                              local daemon health (127.0.0.1)
 *   node src/cli.js inbox [read <deliveryId>]           pending mail / mark one read
 *
 * The token comes from OFFICE_AGENT_TOKEN or the token file (see
 * config.js). It is never printed, never written to disk by this
 * CLI, and never passed as a command-line argument (it would show
 * in the process list).
 */
import { loadConfig, loadPushSecret, ConfigError, BROWSER_USER_AGENT } from "./config.js";
import { resolveToken, tokenSource } from "./vault.js";
import { OfficeRest, OfficeError } from "./office-rest.js";
import { OfficeWs } from "./office-ws.js";
import { Mailbox } from "./mailbox.js";
import { runDaemon } from "./daemon.js";

function usage() {
  console.error(`Usage: node src/cli.js <command> [args]
Commands: daemon, check, me, set-name <name>, create-room, list-rooms,
  send <roomId> <body...>, read [--room <id>] [--limit N],
  state <online|working>, health, inbox [read <deliveryId>]`);
  process.exit(2);
}

function fail(err, code = 1) {
  if (err instanceof OfficeError) {
    console.error(`office error: HTTP ${err.status} (${err.code}): ${err.message}`);
  } else if (err instanceof ConfigError) {
    console.error(`config error: ${err.message}`);
  } else {
    console.error(`error: ${err.message ?? err}`);
  }
  process.exit(code);
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = value;
        i++;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === "daemon") {
    try {
      await runDaemon();
    } catch (err) {
      fail(err);
    }
    return;
  }

  if (cmd === "health") {
    const config = loadConfig();
    try {
      const res = await fetch(`http://127.0.0.1:${config.localPort}/health`, {
        headers: { "User-Agent": BROWSER_USER_AGENT },
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    } catch {
      console.error(`daemon is not running (no answer on 127.0.0.1:${config.localPort})`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "inbox") {
    const config = loadConfig();
    const mailbox = new Mailbox({ inboxDir: config.inboxDir, readDir: config.readDir, stateDir: config.stateDir });
    if (args[0] === "read" && args[1]) {
      const ok = mailbox.markRead(args[1]);
      console.log(ok ? `marked read: ${args[1]}` : `not in inbox: ${args[1]}`);
      return;
    }
    const pending = mailbox.listPending();
    if (pending.length === 0) {
      console.log("inbox empty");
      return;
    }
    for (const item of pending) {
      const msg = item.envelope?.message ?? {};
      console.log(`${item.delivery_id}  room=${msg.roomId ?? "?"} from=${msg.from?.name ?? "?"} body=${String(msg.body ?? "").slice(0, 120)}`);
    }
    return;
  }

  // Everything below needs the office token (env/file, or a fresh
  // vault surrogate per call — see vault.js).
  let config;
  let rest;
  try {
    config = loadConfig();
    const getToken = () => resolveToken();
    rest = new OfficeRest(config.baseUrl, getToken);
  } catch (err) {
    fail(err);
  }

  try {
    if (cmd === "check") {
      const lines = [];
      const ok = (name, detail) => lines.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
      const bad = (name, detail) => lines.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
      let allOk = true;
      let token;
      try {
        token = resolveToken();
        const source =
          tokenSource() === "vault"
            ? "vault (Secure Vault, fresh surrogate per call)"
            : `token ${tokenSource()}`;
        ok("token present", `from ${source}`);
      } catch (err) {
        bad("token present", err.message);
        allOk = false;
      }
      try {
        const res = await fetch(`${config.baseUrl}/api/health`, {
          headers: { "User-Agent": BROWSER_USER_AGENT },
        });
        if (res.ok) ok("office reachable", `${config.baseUrl}/api/health → ${res.status}`);
        else {
          bad("office reachable", `HTTP ${res.status}`);
          allOk = false;
        }
      } catch (err) {
        bad("office reachable", err.message);
        allOk = false;
      }
      let me = null;
      if (token) {
        try {
          me = await rest.me();
          ok("auth (GET /api/v1/agent/me)", `${me.name} (${me.id}), scopes: ${(me.scopes ?? []).join(",") || "none"}`);
        } catch (err) {
          bad("auth (GET /api/v1/agent/me)", err instanceof OfficeError ? `HTTP ${err.status} (${err.code})` : err.message);
          allOk = false;
        }
      }
      try {
        const info = await rest.realtimeInfo();
        ok("realtime info", `provider=${info.provider ?? info.mode ?? "?"}, timezone=${info.timezone ?? "?"}`);
      } catch (err) {
        bad("realtime info", err.message);
        allOk = false;
      }
      try {
        const ws = new OfficeWs(config.baseUrl, () => resolveToken(), { reconnectBaseMs: 1000, reconnectMaxMs: 5000 });
        await ws.connect({ timeoutMs: 15000 });
        ok("WS gateway", "connected (auth accepted)");
        ws.disconnect();
      } catch (err) {
        bad("WS gateway", err.message);
        allOk = false;
      }
      try {
        const secret = loadPushSecret();
        ok("push secret present", secret ? "yes (optional; WS is primary)" : "no (optional; WS is primary)");
      } catch (err) {
        bad("push secret", err.message);
      }
      console.log(lines.join("\n"));
      console.log(allOk ? "CHECK OK — ready for the live handshake." : "CHECK FAILED — fix the FAIL lines (see RUNBOOK.md).");
      process.exit(allOk ? 0 : 1);
    }

    if (cmd === "me") {
      console.log(JSON.stringify(await rest.me(), null, 2));
      return;
    }

    if (cmd === "set-name") {
      const name = args[0];
      if (!name) usage();
      console.log(JSON.stringify(await rest.setName(name), null, 2));
      return;
    }

    if (cmd === "create-room") {
      const { flags } = parseFlags(args);
      const kind = flags.kind ?? "main";
      const title = typeof flags.title === "string" ? flags.title : undefined;
      const participantsRaw = flags.participants;
      if (!participantsRaw || typeof participantsRaw !== "string") {
        console.error("create-room needs --participants (at least user:<veo-user-id>; your own agent id is added automatically; add other agents as agent:<id> to invite them)");
        process.exit(2);
      }
      const participants = participantsRaw.split(",").map((p) => {
        const [type, id] = p.split(":");
        return { type, id };
      });
      const room = await rest.createRoom({ kind, title, participants });
      console.log(JSON.stringify(room, null, 2));
      console.log(`ROOM_ID=${room.id}`);
      return;
    }

    if (cmd === "list-rooms") {
      console.log(JSON.stringify(await rest.listRooms(), null, 2));
      return;
    }

    if (cmd === "send") {
      const { flags, rest: restArgs } = parseFlags(args);
      const roomId = restArgs[0];
      const body = restArgs.slice(1).join(" ");
      if (!roomId || !body) usage();
      const msg = await rest.sendMessage(roomId, {
        body,
        replyToId: typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined,
        clientMsgId: `${config.agentName}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      });
      console.log(JSON.stringify(msg, null, 2));
      return;
    }

    if (cmd === "read") {
      const { flags } = parseFlags(args);
      const roomId = flags.room;
      if (!roomId || typeof roomId !== "string") {
        console.error("read needs --room <roomId>");
        process.exit(2);
      }
      const limit = Number(flags.limit ?? "35");
      console.log(JSON.stringify(await rest.listMessages(roomId, { limit }), null, 2));
      return;
    }

    if (cmd === "state") {
      const state = args[0];
      if (state !== "online" && state !== "working") usage();
      console.log(JSON.stringify(await rest.setState(state), null, 2));
      return;
    }

    usage();
  } catch (err) {
    fail(err);
  }
}

main();

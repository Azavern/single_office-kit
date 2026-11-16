/**
 * Mailbox: one JSON file per office delivery, in inbox/.
 *
 * This is the wake boundary. The daemon appends a file the moment a
 * delivery arrives (WS or push); a hook (<agent>-office-watch, see
 * ~/hooks/scripts/<agent>-office-watch.sh) lists inbox/ every few seconds
 * and wakes the agent only when a NEW file appears. Nothing polls the
 * office — the office pushes (WS/push), the daemon files, the hook
 * watches the local directory (Q-21, Veo's no-polling correction).
 *
 * Dedupe: delivery ids are remembered in state/seen.json, so a
 * redelivery (or a daemon restart) never files the same delivery
 * twice. markRead() moves a handled file to read/ — the hook only
 * looks at inbox/, so handled mail never re-wakes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Mailbox {
  constructor({ inboxDir, readDir, stateDir }) {
    this.inboxDir = inboxDir;
    this.readDir = readDir;
    this.stateDir = stateDir;
    this.seenFile = join(stateDir, "seen.json");
    this.seen = new Set(this.#loadSeen());
  }

  #loadSeen() {
    try {
      const raw = readFileSync(this.seenFile, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  #saveSeen() {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.seenFile, JSON.stringify([...this.seen].sort(), null, 2) + "\n", "utf8");
  }

  #ensureDirs() {
    mkdirSync(this.inboxDir, { recursive: true });
    mkdirSync(this.readDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
  }

  hasSeen(deliveryId) {
    return this.seen.has(deliveryId);
  }

  /**
   * File one delivery. Returns { stored: true } on first sight,
   * { stored: false, duplicate: true } on a redelivery.
   */
  store(deliveryId, envelope) {
    if (typeof deliveryId !== "string" || deliveryId === "") {
      throw new Error("mailbox.store needs a delivery id");
    }
    if (this.seen.has(deliveryId)) return { stored: false, duplicate: true };
    this.#ensureDirs();
    const file = join(this.inboxDir, `${deliveryId}.json`);
    const record = {
      delivery_id: deliveryId,
      received_at: new Date().toISOString(),
      envelope,
    };
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    this.seen.add(deliveryId);
    this.#saveSeen();
    return { stored: true, file };
  }

  /** Pending deliveries, oldest first (by file mtime — sub-millisecond, unlike the ISO received_at). */
  listPending() {
    if (!existsSync(this.inboxDir)) return [];
    const out = [];
    for (const name of readdirSync(this.inboxDir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.inboxDir, name);
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        out.push({ record, mtimeMs: statSync(file).mtimeMs });
      } catch {
        // A half-written file (daemon killed mid-write) is skipped;
        // the delivery id stays in seen.json, so a redelivery or the
        // next sweep re-files it. Never crash the listing on one file.
      }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs).map((entry) => entry.record);
  }

  /** Move a handled delivery out of inbox/ so it never re-wakes. */
  markRead(deliveryId) {
    const file = join(this.inboxDir, `${deliveryId}.json`);
    if (!existsSync(file)) return false;
    this.#ensureDirs();
    renameSync(file, join(this.readDir, `${deliveryId}.json`));
    return true;
  }
}

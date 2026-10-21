// Shared paths, file helpers and the daemon client used by alarmd.mjs, mcp.mjs and cli.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.T3_ALARM_HOME || path.join(os.homedir(), ".t3-alarm");
export const PATHS = {
  token: path.join(HOME, "token"),
  alarms: path.join(HOME, "alarms.json"),
  daemon: path.join(HOME, "daemon.json"),
  log: path.join(HOME, "alarmd.log"),
};
export const DEFAULT_PORT = 47731;

// T3 Code's own state lives here; its server writes the port it is listening on to server-runtime.json.
export const T3_HOME = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
export const T3_RUNTIME = path.join(T3_HOME, "userdata", "server-runtime.json");
export const T3_DB = path.join(T3_HOME, "userdata", "state.sqlite");

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash or sleep mid-write never leaves half a file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function fmtLocal(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/**
 * Parse when an alarm should fire. `inMinutes` wins. `at` takes an ISO time with an offset,
 * a local "YYYY-MM-DD HH:MM", or a local "HH:MM" / "7pm" / "7:30 pm" (the next time that clock time comes round).
 */
export function parseWhen({ at, inMinutes }, now = new Date()) {
  if (inMinutes !== undefined && inMinutes !== null && inMinutes !== "") {
    const minutes = Number(inMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("in_minutes must be a positive number");
    return new Date(now.getTime() + minutes * 60_000);
  }
  if (!at) throw new Error("give either at or in_minutes");
  const text = String(at).trim();
  const clock = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new Error(`not a clock time: ${text}`);
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  const when = local
    ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]))
    : new Date(text);
  if (Number.isNaN(when.getTime())) throw new Error(`can't read the time: ${text}`);
  if (when <= now) throw new Error(`${fmtLocal(when.toISOString())} is already past`);
  return when;
}

// "You've hit your session limit · resets 7pm (America/Los_Angeles)", or "resets Oct 20, 3pm" for a longer one.
export const LIMIT_RE = /hit your (?:[\w-]+ )?limit[^\n]*?resets\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+)?(\d{1,2}(?::\d{2})?\s*[ap]m)/i;

/** When a usage-limit message says the limit resets: the first such local time after `from`, plus a 90 s margin. */
export function limitResetsAt(text, from = new Date()) {
  const match = text.match(LIMIT_RE);
  if (!match) return null;
  const when = new Date(from);
  const clock = match[2].replace(/\s+/g, "").toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  let hour = Number(clock[1]) % 12;
  if (clock[3] === "pm") hour += 12;
  if (match[1]) {
    const day = new Date(`${match[1].replace(",", "")} ${when.getFullYear()}`);
    if (!Number.isNaN(day.getTime())) when.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  }
  when.setHours(hour, Number(clock[2] ?? 0), 0, 0);
  if (!match[1] && when <= new Date(from)) when.setDate(when.getDate() + 1);
  return new Date(when.getTime() + 90_000);
}

/**
 * Threads whose latest turn ended at a usage limit no more than `windowMs` before `now`, and whose
 * limit resets no more than `windowMs` after it was hit: the five-hour limit, not the weekly one.
 * The reset time is T3's own `runtime.warning` for that turn when it recorded one (it doesn't always),
 * otherwise the "resets 7pm" in the reply, read from when the turn ended.
 */
export async function findLimitStalls(now = new Date(), windowMs = 5 * 3600_000) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(T3_DB, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`
      select t.thread_id, tu.turn_id, tu.completed_at, m.text,
        (select json_extract(a.payload_json, '$.detail.resetsAt') from projection_thread_activities a
          where a.thread_id = t.thread_id and a.turn_id = tu.turn_id and a.kind = 'runtime.warning'
            and json_extract(a.payload_json, '$.detail.resetsAt') is not null
          order by a.sequence desc limit 1) as resets_at
      from projection_threads t
      join projection_turns tu on tu.thread_id = t.thread_id and tu.turn_id = t.latest_turn_id
      left join projection_thread_messages m on m.message_id = tu.assistant_message_id
      where t.deleted_at is null and t.archived_at is null and tu.state = 'error'
        and tu.completed_at >= ? and tu.completed_at <= ?`)
      .all(new Date(now.getTime() - windowMs).toISOString(), now.toISOString());
  } finally {
    db.close();
  }
  const stalls = [];
  for (const row of rows) {
    const hitAt = new Date(row.completed_at);
    const resetAt = row.resets_at ? new Date(row.resets_at * 1000 + 90_000) : limitResetsAt(row.text ?? "", hitAt);
    if (!resetAt || resetAt - 90_000 - hitAt > windowMs) continue;
    stalls.push({ threadId: row.thread_id, turnId: row.turn_id, hitAt, resetAt });
  }
  return stalls;
}

/** Call the daemon's control API on 127.0.0.1. Throws if it isn't running. */
export async function daemonRequest(method, route, body) {
  const info = readJson(PATHS.daemon, null);
  if (!info?.port || !info?.secret) throw new Error("alarm daemon has never started");
  const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-alarm-secret": info.secret },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `daemon answered HTTP ${response.status}`);
  return data;
}

/** Start the daemon in the background if it isn't answering, and wait for it. */
export async function ensureDaemon() {
  try {
    return await daemonRequest("GET", "/status");
  } catch {
    // Not running: start it detached and hidden, so it outlives whoever started it.
  }
  const child = spawn(process.execPath, [path.join(CODE_DIR, "alarmd.mjs")], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      return await daemonRequest("GET", "/status");
    } catch {}
  }
  throw new Error(`alarm daemon did not start; see ${PATHS.log}`);
}

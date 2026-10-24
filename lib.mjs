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
// T3 Code 0.1.2 moved threads from state.sqlite (frozen, no longer written) to statev2.sqlite.
export const T3_DB = path.join(T3_HOME, "userdata", "statev2.sqlite");
export const T3_CLI = process.env.T3CODE_CLI_PATH || path.join(T3_HOME, "bin", process.platform === "win32" ? "t3.cmd" : "t3");

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

/**
 * When a usage-limit message says the limit resets: that local time on or after `from`, plus a 90 s
 * margin. A time up to 15 minutes before `from` is taken as just past, not as tomorrow: the reply
 * can land a little after the stated reset. A date more than a day before `from` is next year's.
 */
export function limitResetsAt(text, from = new Date()) {
  const match = text.match(LIMIT_RE);
  if (!match) return null;
  const base = new Date(from);
  const when = new Date(base);
  const clock = match[2].replace(/\s+/g, "").toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  let hour = Number(clock[1]) % 12;
  if (clock[3] === "pm") hour += 12;
  if (match[1]) {
    const day = new Date(`${match[1].replace(",", "")} ${when.getFullYear()}`);
    if (!Number.isNaN(day.getTime())) when.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  }
  when.setHours(hour, Number(clock[2] ?? 0), 0, 0);
  if (match[1] && when < base - 24 * 3600_000) when.setFullYear(when.getFullYear() + 1);
  if (!match[1] && when < base - 15 * 60_000) when.setDate(when.getDate() + 1);
  return new Date(when.getTime() + 90_000);
}

/** Run `fn` with a read-only handle on T3's database, closed afterwards. */
async function withDb(fn) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(T3_DB, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Where a thread stands, from its latest run: `{ deletedAt, archivedAt, runId, state, requestedAt, reply, error, limitResetAt }`,
 * or null if T3 has no such thread. `state` is the run's status (queued, running, completed, failed, ...);
 * `reply` is the assistant text of that run and `error` the message of its terminal failure, if any.
 */
export async function readThreadState(threadId) {
  return withDb((db) => {
    const thread = db.prepare("select archived_at, deleted_at from orchestration_v2_projection_threads where thread_id = ?").get(threadId);
    if (!thread) return null;
    const run = db.prepare(
      "select run_id, status, requested_at from orchestration_v2_projection_runs where thread_id = ? order by ordinal desc limit 1",
    ).get(threadId);
    const state = { deletedAt: thread.deleted_at, archivedAt: thread.archived_at, runId: null, state: null, requestedAt: null, reply: "", error: "" };
    if (!run) return state;
    const items = db.prepare(
      `select type, json_extract(payload_json, '$.text') as text, json_extract(payload_json, '$.failure.message') as failure,
         case json_extract(payload_json, '$.failure.class') when 'usage_limit' then json_extract(payload_json, '$.failure.resetAt') end as reset_at
       from orchestration_v2_projection_turn_items where run_id = ? and type in ('assistant_message', 'error') order by ordinal`,
    ).all(run.run_id);
    return {
      ...state, runId: run.run_id, state: run.status, requestedAt: run.requested_at,
      reply: items.filter((i) => i.type === "assistant_message").map((i) => i.text ?? "").join("\n"),
      error: items.filter((i) => i.type === "error").map((i) => i.failure ?? "").join("\n"),
      limitResetAt: items.findLast((i) => i.reset_at)?.reset_at ?? null,
    };
  });
}

/** Which T3 thread a Claude Code session belongs to: T3 records the native session it resumes per provider thread. */
export async function threadForClaudeSession(sessionId) {
  return withDb((db) => db.prepare(
    "select thread_id from orchestration_v2_projection_provider_threads where json_extract(payload_json, '$.nativeThreadRef.nativeId') = ? limit 1",
  ).get(sessionId)?.thread_id ?? null);
}

/**
 * Threads whose latest run failed at a usage limit no more than `windowMs` before `now`, and whose
 * limit resets no more than `windowMs` after it was hit: the five-hour limit, not the weekly one.
 * The reset time is the `resetAt` T3 records on the run's usage_limit failure when it has one,
 * otherwise the "resets 7pm" in the reply, read from when the run ended. `turnId` is the run id.
 */
export async function findLimitStalls(now = new Date(), windowMs = 5 * 3600_000) {
  const rows = await withDb((db) => db.prepare(`
    select r.thread_id, r.run_id, r.completed_at,
      (select json_extract(i.payload_json, '$.failure.resetAt') from orchestration_v2_projection_turn_items i
        where i.run_id = r.run_id and i.type = 'error' and json_extract(i.payload_json, '$.failure.class') = 'usage_limit'
        order by i.ordinal desc limit 1) as reset_at,
      (select group_concat(json_extract(i.payload_json, '$.text'), char(10)) from orchestration_v2_projection_turn_items i
        where i.run_id = r.run_id and i.type = 'assistant_message') as text,
      exists (select 1 from orchestration_v2_projection_turn_items i
        where i.run_id = r.run_id and i.type = 'error' and json_extract(i.payload_json, '$.failure.class') = 'usage_limit') as is_limit
    from orchestration_v2_projection_threads t
    join orchestration_v2_projection_runs r on r.thread_id = t.thread_id
      and r.ordinal = (select max(ordinal) from orchestration_v2_projection_runs where thread_id = t.thread_id)
    where t.deleted_at is null and t.archived_at is null and r.status = 'failed'
      and r.completed_at >= ? and r.completed_at <= ?`)
    .all(new Date(now.getTime() - windowMs).toISOString(), now.toISOString()));
  const stalls = [];
  for (const row of rows) {
    const hitAt = new Date(row.completed_at);
    // A failed run counts only if T3 classed it as a usage limit, or its reply says it hit one.
    const resetAt = row.reset_at ? new Date(new Date(row.reset_at).getTime() + 90_000)
      : row.is_limit || LIMIT_RE.test(row.text ?? "") ? limitResetsAt(row.text ?? "", hitAt) : null;
    const gap = resetAt ? resetAt - 90_000 - hitAt : NaN;
    if (!(gap >= -15 * 60_000 && gap <= windowMs)) continue; // NaN fails too
    stalls.push({ threadId: row.thread_id, turnId: row.run_id, hitAt, resetAt });
  }
  return stalls;
}

/**
 * Send `text` into a thread as a user message with T3's own CLI (`t3 thread send`), which queues it
 * behind a run in progress rather than interrupting it. Throws with the CLI's output if it refuses.
 */
export function sendToThread(threadId, text) {
  return new Promise((resolve, reject) => {
    // .cmd shims need a shell on Windows; the text goes in on stdin so it is never quoted.
    const child = spawn(`"${T3_CLI}"`, ["thread", "send", threadId, "-"], { shell: true, windowsHide: true, env: { ...process.env, T3CODE_HOME: T3_HOME } });
    let out = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(Object.assign(new Error(`t3 thread send exited ${code}: ${out.trim().slice(0, 300)}`), { output: out }));
    });
    child.stdin.end(text);
  });
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

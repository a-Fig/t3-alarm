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

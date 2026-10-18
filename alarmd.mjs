// The alarm daemon: keeps alarms on disk, and at each alarm's time sends its prompt into a T3 Code
// thread as a user message, through T3 Code's own local HTTP API. One instance per user; started at
// login (Startup folder), by the MCP server, and by each alarm's wake task, whichever comes first.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  CODE_DIR, DEFAULT_PORT, HOME, PATHS, T3_DB, T3_RUNTIME, VERSION, fmtLocal, readJson, writeJsonAtomic,
} from "./lib.mjs";

const TICK_MS = 15_000; // also how late an alarm can be while the laptop is awake
const WAIT_FOR_IDLE_MS = 30 * 60_000; // a thread mid-turn gets this long before the alarm goes in anyway
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;
const BACKOFF_MIN = [1, 2, 5, 15, 30, 60];
const LIMIT_RE = /hit your (?:[\w-]+ )?limit[^\n]*?resets\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+)?(\d{1,2}(?::\d{2})?\s*[ap]m)/i;

fs.mkdirSync(HOME, { recursive: true });

// --- log: one file, rolled over at 1 MB ---
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}\n`;
  try {
    if (fs.existsSync(PATHS.log) && fs.statSync(PATHS.log).size > 1_000_000) fs.renameSync(PATHS.log, `${PATHS.log}.1`);
    fs.appendFileSync(PATHS.log, line);
  } catch {}
}

// --- store ---
let alarms = readJson(PATHS.alarms, []);
const save = () => writeJsonAtomic(PATHS.alarms, alarms);
const active = (a) => !["delivered", "cancelled", "failed"].includes(a.status);

// --- T3 Code ---
function t3Origin() {
  const runtime = readJson(T3_RUNTIME, null);
  return runtime?.port ? `http://127.0.0.1:${runtime.port}` : "http://127.0.0.1:3773";
}
function t3Token() {
  try {
    return fs.readFileSync(PATHS.token, "utf8").trim();
  } catch {
    return null;
  }
}
async function t3(method, route, body) {
  const token = t3Token();
  if (!token) throw Object.assign(new Error(`no T3 token at ${PATHS.token}`), { permanent: true });
  const response = await fetch(`${t3Origin()}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    const error = new Error(`T3 ${method} ${route} → HTTP ${response.status}: ${text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const readThread = (threadId) => t3("GET", `/api/orchestration/threads/${threadId}?turnLimit=2`).then((d) => d.thread);

/** Which T3 thread a Claude Code session belongs to: T3 records the session it resumes per thread. */
async function threadForClaudeSession(sessionId) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(T3_DB, { readOnly: true });
  try {
    const row = db
      .prepare("select thread_id from provider_session_runtime where json_extract(resume_cursor_json, '$.resume') = ?")
      .get(sessionId);
    return row?.thread_id ?? null;
  } finally {
    db.close();
  }
}

// --- wake tasks: a Windows scheduled task per alarm that wakes the laptop a minute early and
// starts this daemon if it isn't running. Best effort: the power plan decides whether wake timers
// may wake the machine (often only on AC). ---
function powershell(script) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}${stderr}`.trim().slice(0, 300) }));
  });
}
async function addWakeTask(alarm) {
  const at = new Date(new Date(alarm.fireAt).getTime() - 60_000);
  const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}:00`;
  const launcher = path.join(CODE_DIR, "launch-hidden.vbs").replace(/'/g, "''");
  const result = await powershell(
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${launcher}"';` +
    `$t = New-ScheduledTaskTrigger -Once -At ([datetime]'${local}');` +
    `$s = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5);` +
    `Register-ScheduledTask -TaskPath '\\t3-alarm\\' -TaskName 'alarm-${alarm.id}' -Action $a -Trigger $t -Settings $s -Force | Out-Null; 'ok'`,
  );
  alarm.wakeTask = result.ok ? "set" : `failed: ${result.out}`;
  log("wake task", alarm.id, alarm.wakeTask);
  save();
}
async function removeWakeTask(alarm) {
  if (alarm.wakeTask !== "set") return;
  await powershell(`Unregister-ScheduledTask -TaskPath '\\t3-alarm\\' -TaskName 'alarm-${alarm.id}' -Confirm:$false -ErrorAction SilentlyContinue`);
  alarm.wakeTask = "removed";
}

// --- firing ---
function retryAt(alarm, minutes, reason) {
  alarm.status = "retrying";
  alarm.nextAttemptAt = new Date(Date.now() + minutes * 60_000).toISOString();
  alarm.lastIssue = reason;
  log("retry", alarm.id, `in ${minutes} min:`, reason);
}
function backoff(alarm, reason) {
  alarm.failures = (alarm.failures ?? 0) + 1;
  if (alarm.failures > 12) return finish(alarm, "failed", reason);
  retryAt(alarm, BACKOFF_MIN[Math.min(alarm.failures - 1, BACKOFF_MIN.length - 1)], reason);
}

/** "resets 3:40am" (or "resets Oct 20, 3pm"): the next such local time, plus a 90 s margin. */
function limitResetsAt(text) {
  const match = text.match(LIMIT_RE);
  if (!match) return null;
  const when = new Date();
  const clock = match[2].replace(/\s+/g, "").toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  let hour = Number(clock[1]) % 12;
  if (clock[3] === "pm") hour += 12;
  if (match[1]) {
    const day = new Date(`${match[1].replace(",", "")} ${when.getFullYear()}`);
    if (!Number.isNaN(day.getTime())) when.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  }
  when.setHours(hour, Number(clock[2] ?? 0), 0, 0);
  if (!match[1] && when <= new Date()) when.setDate(when.getDate() + 1);
  return new Date(when.getTime() + 90_000);
}

/** The message as it appears in the thread: the prompt, marked as an alarm, with a note only if it's late. */
function promptText(alarm) {
  const late = Math.round((Date.now() - new Date(alarm.fireAt)) / 60_000);
  return `⏰ ${late >= 2 ? `(${late} min late) ` : ""}${alarm.prompt}`;
}

async function attempt(alarm) {
  alarm.attempts = (alarm.attempts ?? 0) + 1;
  let thread;
  try {
    thread = await readThread(alarm.threadId);
  } catch (error) {
    if (error.status === 404) return finish(alarm, "failed", "thread not found");
    return backoff(alarm, error.cause?.code === "ECONNREFUSED" || /fetch failed/.test(error.message) ? "T3 Code isn't running" : error.message);
  }
  if (thread.deletedAt || thread.archivedAt) return finish(alarm, "failed", "thread was deleted or archived");
  const busy = thread.session?.status === "running" || thread.latestTurn?.state === "running";
  alarm.waitingSince ??= busy ? new Date().toISOString() : undefined;
  if (busy && Date.now() - new Date(alarm.waitingSince) < WAIT_FOR_IDLE_MS) {
    alarm.status = "waiting";
    alarm.lastIssue = "thread is mid-turn; going in when it finishes";
    alarm.nextAttemptAt = new Date(Date.now() + 20_000).toISOString();
    return;
  }
  const messageId = crypto.randomUUID();
  try {
    await t3("POST", "/api/orchestration/dispatch", {
      type: "thread.turn.start",
      commandId: crypto.randomUUID(),
      threadId: alarm.threadId,
      message: { messageId, role: "user", text: promptText(alarm), attachments: [] },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    return backoff(alarm, `dispatch failed: ${error.message}`);
  }
  alarm.status = "delivering";
  alarm.dispatchedAt = new Date().toISOString();
  alarm.messageId = messageId;
  alarm.waitingSince = undefined;
  alarm.nextAttemptAt = new Date(Date.now() + 20_000).toISOString();
  log("dispatched", alarm.id, "to", alarm.threadId);
}

/** After dispatch: watch the turn it started. A usage-limit reply means try again after the reset. */
async function verify(alarm) {
  let thread;
  try {
    thread = await readThread(alarm.threadId);
  } catch (error) {
    alarm.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    alarm.lastIssue = `checking the reply: ${error.message}`;
    return;
  }
  const turn = thread.latestTurn;
  const ours = turn && new Date(turn.requestedAt) >= new Date(new Date(alarm.dispatchedAt).getTime() - 5_000);
  const sinceDispatch = Date.now() - new Date(alarm.dispatchedAt);
  if (!ours || turn.state === "running") {
    if (sinceDispatch > 6 * 3600_000) return finish(alarm, "delivered", "still running after 6 h; counted as delivered");
    alarm.nextAttemptAt = new Date(Date.now() + 20_000).toISOString();
    return;
  }
  const reply = thread.messages.filter((m) => m.role === "assistant" && (m.id === turn.assistantMessageId || m.turnId === turn.turnId))
    .map((m) => m.text ?? "").join("\n");
  const evidence = `${reply}\n${thread.session?.lastError ?? ""}`;
  const reset = limitResetsAt(evidence);
  if (reset) {
    alarm.status = "retrying";
    alarm.nextAttemptAt = reset.toISOString();
    alarm.lastIssue = `usage limit; trying again at ${fmtLocal(alarm.nextAttemptAt)}`;
    log("limit", alarm.id, alarm.lastIssue);
    return;
  }
  if (turn.state !== "completed" && !reply.trim()) return backoff(alarm, `turn ended ${turn.state}: ${thread.session?.lastError ?? "no reply"}`);
  return finish(alarm, "delivered", `reply received (${turn.state})`);
}

async function finish(alarm, status, note) {
  alarm.status = status;
  alarm.finishedAt = new Date().toISOString();
  alarm.lastIssue = note;
  alarm.nextAttemptAt = undefined;
  log(status, alarm.id, note);
  await removeWakeTask(alarm);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const alarm of alarms) {
      if (!active(alarm)) continue;
      const due = new Date(alarm.nextAttemptAt ?? alarm.fireAt).getTime();
      if (due > now) continue;
      if (alarm.status === "delivering") await verify(alarm);
      else await attempt(alarm);
      save();
    }
    const before = alarms.length;
    alarms = alarms.filter((a) => active(a) || now - new Date(a.finishedAt ?? a.createdAt) < KEEP_FINISHED_MS);
    if (alarms.length !== before) save();
  } catch (error) {
    log("tick error", error.stack ?? error.message);
  } finally {
    ticking = false;
  }
}

// --- control API ---
const secret = crypto.randomBytes(24).toString("hex");
const startedAt = new Date().toISOString();
const publicAlarm = (a) => ({
  id: a.id, label: a.label, status: a.status, fireAt: a.fireAt, fireAtLocal: fmtLocal(a.fireAt),
  threadId: a.threadId, prompt: a.prompt, attempts: a.attempts ?? 0, nextAttemptAt: a.nextAttemptAt,
  lastIssue: a.lastIssue, wakeTask: a.wakeTask, createdAt: a.createdAt, finishedAt: a.finishedAt,
});

async function status() {
  let t3State;
  try {
    const session = await t3("GET", "/api/auth/session");
    t3State = { reachable: true, origin: t3Origin(), authenticated: session.authenticated === true };
  } catch (error) {
    t3State = { reachable: false, origin: t3Origin(), error: error.message };
  }
  const pending = alarms.filter(active).sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt));
  return {
    ok: true, version: VERSION, pid: process.pid, startedAt, uptimeMinutes: Math.round(process.uptime() / 60),
    home: HOME, t3: t3State, pending: pending.length,
    next: pending[0] ? publicAlarm(pending[0]) : null,
  };
}

async function route(req, body) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/status") return status();
  if (req.method === "GET" && url.pathname === "/alarms") {
    const all = url.searchParams.get("all") === "1";
    return { alarms: alarms.filter((a) => all || active(a)).map(publicAlarm) };
  }
  if (req.method === "POST" && url.pathname === "/alarms") {
    if (!body.prompt?.trim()) throw new Error("prompt is required");
    const fireAt = new Date(body.fireAt);
    if (Number.isNaN(fireAt.getTime())) throw new Error("fireAt must be an ISO time");
    let threadId = body.threadId;
    if (!threadId && body.claudeSessionId) threadId = await threadForClaudeSession(body.claudeSessionId);
    if (!threadId) throw new Error("couldn't tell which T3 thread to wake; pass thread_id");
    await readThread(threadId); // fails loudly now rather than at alarm time
    const alarm = {
      id: crypto.randomBytes(4).toString("hex"), label: body.label?.trim() || undefined, prompt: body.prompt,
      threadId, fireAt: fireAt.toISOString(), createdAt: new Date().toISOString(), status: "scheduled",
      createdBy: body.claudeSessionId,
    };
    alarms.push(alarm);
    save();
    log("set", alarm.id, "for", alarm.fireAt, "thread", threadId);
    if (body.wake !== false) await addWakeTask(alarm);
    setTimeout(tick, Math.max(0, fireAt - Date.now()) + 50).unref();
    return { alarm: publicAlarm(alarm) };
  }
  const cancel = url.pathname.match(/^\/alarms\/([0-9a-f]{8})$/);
  if (req.method === "DELETE" && cancel) {
    const alarm = alarms.find((a) => a.id === cancel[1]);
    if (!alarm) throw new Error(`no alarm ${cancel[1]}`);
    if (active(alarm)) await finish(alarm, "cancelled", "cancelled");
    save();
    return { alarm: publicAlarm(alarm) };
  }
  if (req.method === "POST" && url.pathname === "/shutdown") {
    setTimeout(() => process.exit(0), 100);
    return { ok: true };
  }
  throw Object.assign(new Error("not found"), { status: 404 });
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const reply = (code, data) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers["x-alarm-secret"] !== secret) return reply(401, { error: "bad secret" });
    try {
      reply(200, await route(req, raw ? JSON.parse(raw) : {}));
    } catch (error) {
      reply(error.status ?? 400, { error: error.message });
    }
  });
});

// One instance: if the usual port is taken by a live daemon, leave quietly.
server.on("error", async (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  log("port", DEFAULT_PORT, "busy; another daemon is running, exiting");
  process.exit(0);
});
server.listen(DEFAULT_PORT, "127.0.0.1", () => {
  writeJsonAtomic(PATHS.daemon, { pid: process.pid, port: DEFAULT_PORT, secret, startedAt, version: VERSION });
  log("started", VERSION, "pid", process.pid, "alarms pending", alarms.filter(active).length);
  tick();
  setInterval(tick, TICK_MS);
});

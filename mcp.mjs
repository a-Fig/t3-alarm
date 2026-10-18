// MCP server (stdio, newline-delimited JSON-RPC) that gives Claude Code alarm tools. It starts the
// daemon if needed, and works out which T3 thread it belongs to from the Claude Code process that
// launched it (T3 starts each session with --resume=<session id>).
import { execFile } from "node:child_process";
import readline from "node:readline";
import { VERSION, daemonRequest, ensureDaemon, fmtLocal, parseWhen } from "./lib.mjs";

const TOOLS = [
  {
    name: "alarm_set",
    description:
      "Set an alarm. At its time, `prompt` arrives in this conversation as a new user message, as if the user had typed it. " +
      "It survives restarts and sleep (a missed alarm goes off as soon as the laptop is awake), waits for a turn in progress to finish, " +
      "and retries after a usage limit resets. Give `in_minutes`, or `at` as an ISO time, a local 'YYYY-MM-DD HH:MM', or a clock time like '19:30' or '7pm' (the next one).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the message should say: write it as instructions to your future self." },
        in_minutes: { type: "number", description: "Minutes from now." },
        at: { type: "string", description: "When, if not in_minutes." },
        label: { type: "string", description: "Short name shown in lists." },
        thread_id: { type: "string", description: "T3 thread to wake. Defaults to this conversation." },
        wake_computer: { type: "boolean", description: "Also schedule a Windows wake timer a minute early (default true)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "alarm_list",
    description: "List alarms: pending ones, or every alarm from the last 7 days with include_finished.",
    inputSchema: { type: "object", properties: { include_finished: { type: "boolean" } } },
  },
  {
    name: "alarm_cancel",
    description: "Cancel an alarm by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "alarm_status",
    description: "Check the alarm daemon: whether it's running, whether it can reach T3 Code, the next alarm, and which thread this conversation is.",
    inputSchema: { type: "object", properties: {} },
  },
];

// --- which Claude Code session launched us ---
let sessionPromise;
function claudeSessionId() {
  sessionPromise ??= new Promise((resolve) => {
    // Every process's parent, plus the session id from each claude.exe command line. Plain
    // "pid parent [session]" lines: some other programs' command lines don't survive JSON.
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { $s = ''; " +
      "if ($_.Name -like 'claude*' -and $_.CommandLine -match '--(?:resume|session-id)[= ]\"?([0-9a-f-]{36})') { $s = $Matches[1] }; " +
      "\"$($_.ProcessId) $($_.ParentProcessId) $s\" }";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 16 << 20, timeout: 30_000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const byPid = new Map();
        for (const row of stdout.split(/\r?\n/)) {
          const [pid, parent, session] = row.trim().split(" ");
          if (pid) byPid.set(Number(pid), { parent: Number(parent), session });
        }
        let pid = process.ppid;
        for (let hops = 0; hops < 8 && byPid.has(pid); hops++) {
          const row = byPid.get(pid);
          if (row.session) return resolve(row.session);
          pid = row.parent;
        }
        resolve(null);
      });
  });
  return sessionPromise;
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const line = (a) => `${a.id}  ${a.status.padEnd(10)} ${a.fireAtLocal}${a.label ? `  "${a.label}"` : ""}${a.lastIssue ? `  (${a.lastIssue})` : ""}`;

async function call(name, args) {
  await ensureDaemon();
  if (name === "alarm_set") {
    const fireAt = parseWhen({ at: args.at, inMinutes: args.in_minutes });
    const session = args.thread_id ? null : await claudeSessionId();
    const { alarm } = await daemonRequest("POST", "/alarms", {
      prompt: args.prompt, label: args.label, fireAt: fireAt.toISOString(),
      threadId: args.thread_id, claudeSessionId: session, wake: args.wake_computer !== false,
    });
    return text(`Alarm ${alarm.id} set for ${alarm.fireAtLocal} (thread ${alarm.threadId}). Wake timer: ${alarm.wakeTask ?? "not requested"}.`);
  }
  if (name === "alarm_list") {
    const { alarms } = await daemonRequest("GET", `/alarms${args.include_finished ? "?all=1" : ""}`);
    return text(alarms.length ? alarms.map(line).join("\n") : "No alarms.");
  }
  if (name === "alarm_cancel") {
    const { alarm } = await daemonRequest("DELETE", `/alarms/${encodeURIComponent(args.id)}`);
    return text(`Alarm ${alarm.id} is ${alarm.status}.`);
  }
  if (name === "alarm_status") {
    const status = await daemonRequest("GET", "/status");
    const session = await claudeSessionId();
    return text({ ...status, thisClaudeSession: session, nextLocal: status.next ? fmtLocal(status.next.fireAt) : null });
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on("line", async (raw) => {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return; // notifications need no answer
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "t3-alarm", version: VERSION },
      } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        return send({ jsonrpc: "2.0", id, result: await call(params.name, params.arguments ?? {}) });
      } catch (error) {
        return send({ jsonrpc: "2.0", id, result: { ...text(`Error: ${error.message}`), isError: true } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
  }
});

// Warm up: start the daemon now so alarms set earlier resume even if no tool is ever called.
ensureDaemon().catch(() => {});
claudeSessionId();

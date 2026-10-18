// For people: `node cli.mjs status | list [--all] | cancel <id> | set <thread-id> <minutes|time> <prompt…> | stop`.
import { daemonRequest, ensureDaemon, parseWhen, PATHS } from "./lib.mjs";

const [command = "status", ...rest] = process.argv.slice(2);
try {
  if (command === "stop") {
    await daemonRequest("POST", "/shutdown");
    console.log("daemon stopped");
  } else {
    await ensureDaemon();
    if (command === "status") console.log(JSON.stringify(await daemonRequest("GET", "/status"), null, 2));
    else if (command === "list") {
      const { alarms } = await daemonRequest("GET", `/alarms${rest.includes("--all") ? "?all=1" : ""}`);
      for (const a of alarms) console.log(`${a.id}  ${a.status.padEnd(10)} ${a.fireAtLocal}  ${a.label ?? ""}  ${a.lastIssue ?? ""}`);
      if (!alarms.length) console.log("no alarms");
    } else if (command === "cancel") {
      console.log((await daemonRequest("DELETE", `/alarms/${rest[0]}`)).alarm.status);
    } else if (command === "set") {
      const [threadId, when, ...words] = rest;
      const fireAt = /^\d+(\.\d+)?$/.test(when) ? parseWhen({ inMinutes: when }) : parseWhen({ at: when });
      const { alarm } = await daemonRequest("POST", "/alarms", { threadId, fireAt: fireAt.toISOString(), prompt: words.join(" ") });
      console.log(`alarm ${alarm.id} for ${alarm.fireAtLocal}, wake task ${alarm.wakeTask}`);
    } else {
      console.log("usage: node cli.mjs status | list [--all] | cancel <id> | set <thread-id> <minutes|time> <prompt…> | stop");
    }
  }
} catch (error) {
  console.error(`error: ${error.message} (log: ${PATHS.log})`);
  process.exit(1);
}

# t3-alarm

One night I left Claude Code running a long, multi-agent job in T3 Code, set to work until morning. Around midnight it hit my Claude usage limit and every agent stopped mid-task. The timers Claude had set to pick the work back up fired while the limit was still in force, and nothing tried again. By morning the night's work simply hadn't happened.

I wanted an alarm that waits out a usage limit, survives a closed laptop, and drops a message into the conversation as if I'd typed it. This is that.

## What it does

Claude Code, running in T3 Code, can set an alarm. At that time the alarm's prompt arrives in the same thread as a new message (`⏰ …`), through T3 Code's local API. It waits for a turn in progress, and if the reply is a usage-limit error it tries again after the limit resets.

It is a small Windows daemon and an MCP server, with no dependencies.

## Requirements

Windows, Node 24+, [T3 Code](https://t3.codes), Claude Code.

## Install

```powershell
git clone https://github.com/a-Fig/t3-alarm; cd t3-alarm

# Issue a token with T3 Code's own CLI, then save what it prints as ~\.t3-alarm\token
mkdir ~\.t3-alarm -Force | Out-Null
$env:ELECTRON_RUN_AS_NODE = 1
& "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Alpha).exe" `
  "$env:LOCALAPPDATA\Programs\t3code\resources\server.asar\apps\server\dist\bin.mjs" `
  auth session issue --label claude-alarm --ttl 365d --token-only
Remove-Item Env:ELECTRON_RUN_AS_NODE

.\install.ps1
```

`install.ps1` registers the MCP server with Claude Code (`~\.claude` and any `~\.claude_*`; pass `-ClaudeConfigDirs` to choose), starts the daemon at login and starts it now. The token lasts a year.

## Tools

Claude gets four MCP tools: `alarm_set`, `alarm_list`, `alarm_cancel` and `alarm_status`.

```
alarm_set(prompt: "Check the build and finish the migration", at: "7am")
alarm_set(prompt: "Run the tests again", in_minutes: 90, label: "tests")
```

`at` takes a clock time (`19:30`, `7pm`: the next one), `YYYY-MM-DD HH:MM`, or an ISO time. The alarm goes to this conversation unless you pass `thread_id`.

## CLI

```
node cli.mjs status | list [--all] | cancel <id> | set <thread-id> <minutes|time> <prompt…> | stop
```

## How it works

- The daemon (`alarmd.mjs`) listens on `127.0.0.1:47731` and keeps alarms in `~\.t3-alarm\alarms.json`. It checks every 15 seconds, so an alarm missed during sleep goes off as soon as the laptop wakes. It starts at login, with each Claude session in T3, and from each alarm's wake task.
- Each alarm also registers a Windows scheduled task (`\t3-alarm\alarm-<id>`) a minute early, set to wake the computer, which starts the daemon if it isn't running.
- The prompt is posted to T3 Code's HTTP API as a user message. If the thread is mid-turn it waits, up to 30 minutes.
- After sending, it reads the reply. A usage-limit error means another attempt 90 seconds after the stated reset time; other failures retry with backoff.
- The MCP server finds its own thread from the `--resume=<session>` that T3 passes to Claude Code, then looks the session up in T3's database.

## Limits

- Windows only.
- A sleeping laptop wakes for an alarm only if its power plan allows wake timers. Nothing fires while T3 Code is closed; the alarm goes off once it is back.
- T3 Code's API is internal and unversioned, so an update could break this.

## Uninstall

```powershell
node cli.mjs stop
Remove-Item "$([Environment]::GetFolderPath('Startup'))\t3-alarm.vbs"
Get-ScheduledTask -TaskPath '\t3-alarm\' | Unregister-ScheduledTask -Confirm:$false
claude mcp remove --scope user t3-alarm      # once per Claude config dir
Remove-Item -Recurse ~\.t3-alarm
```

Then revoke the token with T3's `auth session list` and `auth session revoke <id>`.

## License

MIT

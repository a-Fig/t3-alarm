# Installs t3-alarm for the current user: a hidden launcher, a Startup-folder entry so the daemon runs
# at every login, the MCP server in each Claude Code config dir T3 Code uses, and the daemon itself.
# The T3 Code bearer token must already be in ~/.t3-alarm/token (see README). Re-running is safe.
# -ClaudeConfigDirs defaults to ~\.claude plus every existing ~\.claude_* directory.
param([string[]]$ClaudeConfigDirs)
$ErrorActionPreference = 'Stop'
if (-not $ClaudeConfigDirs) {
  $ClaudeConfigDirs = @("$env:USERPROFILE\.claude") +
    @(Get-ChildItem -Path $env:USERPROFILE -Directory -Filter '.claude_*' -Force -ErrorAction SilentlyContinue | ForEach-Object FullName)
}
$here = $PSScriptRoot
$node = (Get-Command node).Source
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = "$env:USERPROFILE\.local\bin\claude.exe" }

# 1. Hidden launcher, also used by each alarm's wake task.
$vbs = @"
' Starts the t3-alarm daemon with no window. A second copy exits on its own.
CreateObject("WScript.Shell").Run """$node"" ""$here\alarmd.mjs""", 0, False
"@
Set-Content -Path "$here\launch-hidden.vbs" -Value $vbs -Encoding ASCII

# 2. Run at login.
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item "$here\launch-hidden.vbs" "$startup\t3-alarm.vbs" -Force

# 3. MCP server, user scope, for every Claude Code config dir T3 Code runs with.
foreach ($dir in $ClaudeConfigDirs) {
  if (-not (Test-Path $dir)) { continue }
  $env:CLAUDE_CONFIG_DIR = $dir
  # PowerShell 5.1 turns a native command's stderr into an error, so the "not found" from a first
  # install's remove must not run under Stop.
  $ErrorActionPreference = 'Continue'
  & $claude mcp remove --scope user t3-alarm 2>&1 | Out-Null
  & $claude mcp add --scope user t3-alarm -- $node "$here\mcp.mjs" 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  Write-Output "MCP server registered for $dir"
}
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue

# 4. Start it now.
Start-Process wscript.exe -ArgumentList "`"$here\launch-hidden.vbs`""
Start-Sleep -Seconds 2
& $node "$here\cli.mjs" status

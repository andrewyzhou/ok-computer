# this script controls the agent from any terminal.
# commands: start, stop, restart, status, open, logs, browser login [url], install, uninstall.

param(
  [Parameter(Position = 0)][string]$Command = 'start',
  [Parameter(Position = 1)][string]$Sub,
  [Parameter(Position = 2)][string]$Target,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$pidFile = Join-Path $data 'okc.pid'
$nodePidFile = Join-Path $data 'okc.node.pid'
$supervisorScript = Join-Path $PSScriptRoot 'run.ps1'
$url = 'http://127.0.0.1:4317'
$taskName = 'OK Computer'

# a pid file stays after a crash, a logoff or a reboot, and windows then gives its id to other processes. so a process
# counts only when its command line matches. a file that does not match is deleted.
function Get-Checked([string]$file, [scriptblock]$check) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $text = Get-Content -LiteralPath $file -Raw
  $found = $null
  if ($text -match '^\s*(\d+)\s*$') {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Matches[1])"
    if ($cim -and $cim.CommandLine -and (& $check $cim)) { $found = Get-Process -Id $cim.ProcessId -ErrorAction SilentlyContinue }
  }
  if (-not $found) { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
  return $found
}

function Get-Supervisor {
  return Get-Checked $pidFile { param($p) $p.CommandLine.IndexOf($supervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
}

function Get-AgentProcess([int]$supervisorId) {
  return Get-Checked $nodePidFile ({ param($p) $p.ParentProcessId -eq $supervisorId -and $p.CommandLine -like '*dist/main.js*' }.GetNewClosure())
}

# the build writes dist/.build-ok as its last step, so a failed build leaves no stamp. folders count too, because a
# deleted or renamed file changes only the time of its folder. a folder list can show an old time for some seconds, so
# each item reads its time again.
function Test-BuildIsOld {
  $stamp = Join-Path $root 'dist/.build-ok'
  if (-not (Test-Path -LiteralPath $stamp)) { return $true }
  $built = (Get-Item -LiteralPath $stamp).LastWriteTime
  $inputs = 'src', 'web/src', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'web/index.html',
    'web/vite.config.ts', 'web/tsconfig.json' | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path -LiteralPath $_ }
  $items = @(Get-Item -LiteralPath $inputs) + @(Get-ChildItem -LiteralPath $inputs -Recurse)
  return [bool]($items | Where-Object { $_.Refresh(); $_.LastWriteTime -gt $built } | Select-Object -First 1)
}

function Start-Agent {
  if (Get-Supervisor) { Write-Host 'ok computer is already running.' }
  else {
    if (Test-BuildIsOld) {
      Write-Host 'building...'
      Push-Location $root
      try { npm run build --silent | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'the build failed. run npm run build to see why.' } }
      finally { Pop-Location }
    }
    $script = Join-Path $PSScriptRoot 'run.ps1'
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`""
    Write-Host 'ok computer started.'
  }
  if (-not $NoOpen) { Open-Dashboard }
}

function Stop-Agent {
  $sup = Get-Supervisor
  if (-not $sup) { Write-Host 'ok computer is not running.'; return }
  $agent = Get-AgentProcess $sup.Id
  # the supervisor stops first, so it cannot start the agent again.
  Stop-Process -Id $sup.Id -Force
  if ($agent) {
    $nodeId = $agent.Id
    # a forced stop skips the end of the runs, so the agent first gets 10 seconds to stop by itself.
    $tokenFile = Join-Path $data 'okc.stop-token'
    if (Test-Path -LiteralPath $tokenFile) {
      try {
        $body = @{ token = (Get-Content -LiteralPath $tokenFile -Raw).Trim() } | ConvertTo-Json
        Invoke-RestMethod -Method Post -Uri "$url/api/shutdown" -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
        Wait-Process -Id $nodeId -Timeout 10 -ErrorAction SilentlyContinue
      }
      catch { Write-Host 'the agent did not stop by itself, so windows stops it.' }
    }
    Stop-Process -Id $nodeId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile, $nodePidFile -ErrorAction SilentlyContinue
  Write-Host 'ok computer stopped.'
}

function Open-Dashboard {
  # the dashboard needs a few seconds after a start.
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest -Uri "$url/api/overview" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
  }
  Start-Process $url
}

function Show-Status {
  $sup = Get-Supervisor
  if ($sup) { Write-Host "running (supervisor pid $($sup.Id))" } else { Write-Host 'not running' }
  try { Invoke-WebRequest -Uri "$url/api/overview" -UseBasicParsing -TimeoutSec 2 | Out-Null; Write-Host "dashboard: $url" }
  catch { Write-Host 'dashboard: not reachable' }
  $restarts = Join-Path $data 'logs/service.restarts.log'
  if (Test-Path $restarts) { Write-Host 'last restarts:'; Get-Content $restarts -Tail 3 }
}

function Show-Logs {
  $latest = Get-ChildItem -Path (Join-Path $data 'logs') -Filter 'okc-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) { Get-Content $latest.FullName -Tail 40 -Wait } else { Write-Host 'no logs yet.' }
}

# the owner signs in to sites in the agent's own chrome profile. the window is plain chrome, and the agent cannot use
# the profile while it is open.
function Start-BrowserLogin {
  if ($Sub -ne 'login') { Write-Host 'usage: okc browser login [url]'; return }
  Push-Location $root
  try {
    if (Test-BuildIsOld) { npm run build --silent | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'the build failed. run npm run build to see why.' } }
    if ($Target) { node dist/browser/login.js $Target } else { node dist/browser/login.js }
  }
  finally { Pop-Location }
}

function Install-Agent {
  # a command on the path, a desktop shortcut, and a task that starts the agent at logon.
  $bin = Join-Path $env:USERPROFILE '.local\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $shim = "@powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" %*"
  Set-Content -Path (Join-Path $bin 'okc.cmd') -Value $shim -Encoding ascii

  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'OK Computer.lnk'))
  $link.TargetPath = 'powershell.exe'
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" start"
  $link.WorkingDirectory = $root
  $link.Description = 'start ok computer and open the dashboard'
  $link.Save()

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" start -NoOpen"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "installed: okc command, desktop shortcut, and the '$taskName' logon task."
}

function Uninstall-Agent {
  Stop-Agent
  Remove-Item (Join-Path $env:USERPROFILE '.local\bin\okc.cmd') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OK Computer.lnk') -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'uninstalled.'
}

switch ($Command) {
  'start' { Start-Agent }
  'stop' { Stop-Agent }
  'restart' { Stop-Agent; Start-Agent }
  'status' { Show-Status }
  'open' { Open-Dashboard }
  'logs' { Show-Logs }
  'browser' { Start-BrowserLogin }
  'install' { Install-Agent }
  'uninstall' { Uninstall-Agent }
  default { Write-Host 'usage: okc [start|stop|restart|status|open|logs|browser login [url]|install|uninstall] [-NoOpen]' }
}

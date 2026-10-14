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
$url = 'http://127.0.0.1:4317'
$taskName = 'OK Computer'

function Get-Supervisor {
  if (-not (Test-Path $pidFile)) { return $null }
  $id = [int](Get-Content $pidFile -Raw)
  return Get-Process -Id $id -ErrorAction SilentlyContinue
}

function Test-BuildIsOld {
  $main = Join-Path $root 'dist/main.js'
  if (-not (Test-Path $main)) { return $true }
  $built = (Get-Item $main).LastWriteTime
  $newest = Get-ChildItem -Path (Join-Path $root 'src'), (Join-Path $root 'web/src') -Recurse -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  return $newest.LastWriteTime -gt $built
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
  # the supervisor stops first, so it cannot start the agent again.
  Stop-Process -Id $sup.Id -Force
  if (Test-Path $nodePidFile) {
    $nodeId = [int](Get-Content $nodePidFile -Raw)
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

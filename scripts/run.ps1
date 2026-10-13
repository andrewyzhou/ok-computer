# this script keeps the agent process running. okc.ps1 starts it in a hidden window.
# when the agent stops, the script starts it again after a short wait.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Content -Path (Join-Path $data 'okc.pid') -Value $PID

$delay = 5
while ($true) {
  $started = Get-Date
  $out = Join-Path $logs 'service.out.log'
  $err = Join-Path $logs 'service.err.log'
  $node = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' -WorkingDirectory $root `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  Set-Content -Path (Join-Path $data 'okc.node.pid') -Value $node.Id
  $node.WaitForExit()

  # a crash soon after start can repeat, so the wait grows to one minute. a long run resets the wait.
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 60) }
  Add-Content -Path (Join-Path $logs 'service.restarts.log') -Value "$(Get-Date -Format o) exit=$($node.ExitCode) next start in ${delay}s"
  Start-Sleep -Seconds $delay
}

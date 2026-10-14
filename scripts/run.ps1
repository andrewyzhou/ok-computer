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
  # each start gets its own output files, so the next start does not overwrite the output of a crash. the files of
  # the last 10 starts stay.
  Get-ChildItem -LiteralPath $logs -Filter 'service-*.log' | Sort-Object Name -Descending | Select-Object -Skip 18 |
    Remove-Item -ErrorAction SilentlyContinue
  $stamp = $started.ToString('yyyyMMdd-HHmmss')
  $out = Join-Path $logs "service-$stamp.out.log"
  $err = Join-Path $logs "service-$stamp.err.log"
  $node = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' -WorkingDirectory $root `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  # without an open handle, ExitCode stays empty when the output goes to files.
  $null = $node.Handle
  Set-Content -Path (Join-Path $data 'okc.node.pid') -Value $node.Id
  $node.WaitForExit()

  # a crash soon after start can repeat, so the wait grows to one minute. a long run resets the wait.
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 60) }
  # a windows crash code such as 0xC0000409 is easy to find in hex.
  $code = '0x{0:X8}' -f $node.ExitCode
  Add-Content -Path (Join-Path $logs 'service.restarts.log') -Value "$(Get-Date -Format o) exit=$code next start in ${delay}s"
  Start-Sleep -Seconds $delay
}

# this script keeps the agent process running. okc.ps1 starts it in a hidden window.
# when the agent stops, the script starts it again after a short wait.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
# two starts at the same moment, for example the logon task and the desktop shortcut, both see no supervisor. the
# mutex lets one supervisor run for each folder. windows releases it when the process ends, also after a crash.
$mutex = [System.Threading.Mutex]::new($false, 'Local\OkComputerSupervisor:' + $root.ToLowerInvariant().Replace('\', '/'))
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 0 }
Set-Content -Path (Join-Path $data 'okc.pid') -Value $PID

$delay = 5
while ($true) {
  $started = Get-Date
  # an error in one start must not end the supervisor, because nothing starts it again before the next logon. the
  # error goes to the restart log, and the next start comes after the usual wait.
  try {
    # each start gets its own output files, so the next start does not overwrite the output of a crash. the files of
    # the last 10 starts stay.
    Get-ChildItem -LiteralPath $logs -Filter 'service-*.log' | Sort-Object Name -Descending | Select-Object -Skip 18 |
      Remove-Item -ErrorAction SilentlyContinue
    $stamp = $started.ToString('yyyyMMdd-HHmmss')
    $out = Join-Path $logs "service-$stamp.out.log"
    $err = Join-Path $logs "service-$stamp.err.log"
    # OKC_NODE names the node of the agent, as in okc.ps1 and okc.sh. the path is found again at each start, so a node
    # that was installed later counts.
    if ($env:OKC_NODE) {
      if (-not (Test-Path -LiteralPath $env:OKC_NODE -PathType Leaf)) { throw "OKC_NODE is $($env:OKC_NODE), and that is not a program that can run." }
      $nodePath = (Resolve-Path -LiteralPath $env:OKC_NODE).ProviderPath
    }
    else {
      $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $found) { throw 'node is not on the path. put it on the path or set OKC_NODE to its full path.' }
      $nodePath = $found.Source
    }
    $node = Start-Process -FilePath $nodePath -ArgumentList 'dist/main.js' -WorkingDirectory $root `
      -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    # without an open handle, ExitCode stays empty when the output goes to files.
    $null = $node.Handle
    Set-Content -Path (Join-Path $data 'okc.node.pid') -Value $node.Id
    $node.WaitForExit()
    # a windows crash code such as 0xC0000409 is easy to find in hex.
    $result = 'exit=0x{0:X8}' -f $node.ExitCode
  }
  catch { $result = "supervisor error: $($_.Exception.Message)" }

  # a crash soon after start can repeat, so the wait grows to one minute. a long run resets the wait.
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 60) }
  Add-Content -Path (Join-Path $logs 'service.restarts.log') -Value "$(Get-Date -Format o) $result next start in ${delay}s" `
    -ErrorAction SilentlyContinue
  Start-Sleep -Seconds $delay
}

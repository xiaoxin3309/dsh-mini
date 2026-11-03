param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [switch]$KillAll,
  [switch]$NoQuit
)

# Keep at most one background helper alive, and only if it runs the current binary.
# The helper records nothing we can rely on here, so "current binary" is decided by
# start time: a process started after the exe was last written is running this build.
# Anything older is a leftover and gets replaced.
$ErrorActionPreference = 'SilentlyContinue'
$name = [System.IO.Path]::GetFileName($ExePath)
$stamp = (Get-Item -LiteralPath $ExePath).LastWriteTimeUtc

$svc = @(Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $name) |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match '--service') })

$keep = 0
if (-not $KillAll) {
  $best = $null
  foreach ($p in $svc) {
    $start = $p.CreationDate.ToUniversalTime()
    if ($start -ge $stamp) {
      if ($null -eq $best -or $start -gt $best.Start) {
        $best = [pscustomobject]@{ Pid = [int]$p.ProcessId; Start = $start }
      }
    }
  }
  if ($null -ne $best) { $keep = $best.Pid }
}

$doomed = @($svc | Where-Object { [int]$_.ProcessId -ne $keep })
$killed = @()
if ($doomed.Count -gt 0) {
  if (-not $NoQuit) {
    # Polite exit first: the helper disposes its tray icon on the way out.
    Set-Content -LiteralPath (Join-Path $DataDir 'quit.txt') -Value '1' -Encoding ASCII
    $deadline = (Get-Date).AddMilliseconds(2000)
    while ((Get-Date) -lt $deadline) {
      $left = @($doomed | Where-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue })
      if ($left.Count -eq 0) { break }
      Start-Sleep -Milliseconds 120
    }
    Remove-Item -LiteralPath (Join-Path $DataDir 'quit.txt') -ErrorAction SilentlyContinue
  }
  foreach ($p in $doomed) {
    $proc = Get-Process -Id ([int]$p.ProcessId) -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    Stop-Process -Id ([int]$p.ProcessId) -Force
    $killed += [int]$p.ProcessId
  }
}

[pscustomobject]@{
  kept    = $keep
  running = @($svc | ForEach-Object { [int]$_.ProcessId })
  killed  = $killed
} | ConvertTo-Json -Compress

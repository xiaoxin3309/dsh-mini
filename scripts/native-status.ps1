# Reports or raises the native HUD shell (the DSH popout window).
# Prints one JSON line so the host's runScript helper can parse it.
param(
  [ValidateSet('status', 'focus')]
  [string]$Action = 'status',

  [int]$WaitMs = 0
)

$ErrorActionPreference = 'Continue'

# The executable name carries two CJK characters; build it from code points so the
# script stays readable in any code page.
$pattern = '*DSH' + [char]0x5C0F + [char]0x7A97 + '.exe'

if (-not ('HudNative.Win' -as [type])) {
  Add-Type -Namespace HudNative -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
'@
}

function Find-HudWindow {
  $procs = @()
  try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and ($_.ExecutablePath -like $pattern) -and ($_.CommandLine -notlike '*--service*')
    })
  } catch {
    $procs = @()
  }
  foreach ($item in $procs) {
    $proc = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) { return $proc }
  }
  # A shell without a main window (minimised to tray) still counts as running.
  if ($procs.Count -gt 0) { return Get-Process -Id $procs[0].ProcessId -ErrorAction SilentlyContinue }
  return $null
}

$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $WaitMs))
while ($true) {
  $proc = Find-HudWindow
  if ($proc) {
    $hwnd = [int64]$proc.MainWindowHandle
    if ($Action -eq 'focus' -and $hwnd -ne 0) {
      try {
        [void][HudNative.Win]::ShowWindow([System.IntPtr]$hwnd, 9)
        [void][HudNative.Win]::BringWindowToTop([System.IntPtr]$hwnd)
        [void][HudNative.Win]::SetForegroundWindow([System.IntPtr]$hwnd)
      } catch {
        # Focus is best effort; the shell is topmost on its own most of the time.
      }
    }
    Write-Output ('{"status":"ok","data":{"found":true,"pid":' + $proc.Id + ',"hwnd":' + $hwnd + ',"action":"' + $Action + '"}}')
    exit 0
  }
  if ([DateTime]::UtcNow -ge $deadline) { break }
  Start-Sleep -Milliseconds 150
}

Write-Output '{"status":"ok","data":{"found":false}}'

# win-hud.ps1 - locate / pin / focus / close the DSH HUD window.
#
# The HUD is an Edge or Chrome `--app` window. It is identified two ways, because
# neither alone is reliable:
#   * by page title prefix  -> stable once the HUD page has loaded its own title
#   * by owner process tree -> works even before the page has set its title
# A window is accepted when it belongs to a browser process AND either test hits.
#
# Output: one line of JSON.
#   {"status":"ok","data":{...}}   |   {"status":"error","error":"..."}
#
# ASCII-only source on purpose: Windows PowerShell 5.1 reads a BOM-less file as the
# ANSI codepage. User-facing text arrives through -Title, and command-line
# arguments cross the process boundary as UTF-16, so Chinese survives.

param(
  [ValidateSet('pin', 'focus', 'close', 'status')]
  [string]$Action = 'pin',
  [string]$Title = '',
  [string]$TitleB64 = '',
  [int]$OwnerPid = 0,
  [int]$Width = 460,
  [int]$Height = 920,
  [int]$Margin = 8,
  [int]$WaitMs = 0,
  [switch]$NoTopmost
)

if (-not [string]::IsNullOrEmpty($TitleB64)) { $Title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TitleB64)) }

$ErrorActionPreference = 'Stop'

if (-not ([System.Management.Automation.PSTypeName]'Hud.Win').Type) {
  # -TypeDefinition (not -MemberDefinition): this block needs `using` directives and
  # top-level structs/delegates, which a member-definition class body cannot hold.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace Hud {
  public struct HudRect { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct HudMonitorInfo { public int cbSize; public HudRect rcMonitor; public HudRect rcWork; public uint dwFlags; }

  public delegate bool HudEnumProc(IntPtr hWnd, IntPtr lParam);

  public static class Win {
    [DllImport("user32.dll")] public static extern bool EnumWindows(HudEnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out HudRect r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr mon, ref HudMonitorInfo mi);
  }
}
'@
}

$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SW_RESTORE = 9
$WM_CLOSE = 0x0010
$WS_EX_TOPMOST = 0x00000008

function Get-Title([IntPtr]$h) {
  $len = [Hud.Win]::GetWindowTextLengthW($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Hud.Win]::GetWindowTextW($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function New-PidTree([int]$root) {
  $set = @{}
  if ($root -le 0) { return $set }
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
  $byParent = @{}
  foreach ($proc in $procs) {
    $parentId = [int]$proc.ParentProcessId
    if (-not $byParent.ContainsKey($parentId)) { $byParent[$parentId] = New-Object System.Collections.ArrayList }
    [void]$byParent[$parentId].Add([int]$proc.ProcessId)
  }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $set[$root] = $true
  while ($queue.Count -gt 0) {
    $current = [int]$queue.Dequeue()
    if (-not $byParent.ContainsKey($current)) { continue }
    foreach ($childId in $byParent[$current]) {
      if ($set.ContainsKey($childId)) { continue }
      $set[$childId] = $true
      $queue.Enqueue($childId)
    }
  }
  return $set
}

function Find-HudWindows([string]$prefix, [int]$ownerPid) {
  # Script scope on purpose: the EnumWindows callback is invoked from native code,
  # so it can only reach variables that live in the script scope.
  $script:browserPids = @{}
  foreach ($p in (Get-Process -Name msedge, chrome -ErrorAction SilentlyContinue)) { $script:browserPids[[int]$p.Id] = $p.ProcessName }
  $script:pidsInTree = New-PidTree $ownerPid
  $script:titlePrefix = $prefix
  $script:found = New-Object System.Collections.ArrayList

  $cb = {
    param([IntPtr]$h, [IntPtr]$l)
    if (-not [Hud.Win]::IsWindowVisible($h)) { return $true }
    $processId = [uint32]0
    [void][Hud.Win]::GetWindowThreadProcessId($h, [ref]$processId)
    if (-not $script:browserPids.ContainsKey([int]$processId)) { return $true }

    $title = Get-Title $h
    $titleHit = (-not [string]::IsNullOrWhiteSpace($script:titlePrefix)) -and
      (-not [string]::IsNullOrWhiteSpace($title)) -and $title.StartsWith($script:titlePrefix)
    $pidHit = $script:pidsInTree.ContainsKey([int]$processId)
    if (-not ($titleHit -or $pidHit)) { return $true }

    [Hud.HudRect]$r = New-Object Hud.HudRect
    [void][Hud.Win]::GetWindowRect($h, [ref]$r)
    [void]$script:found.Add([pscustomobject]@{
      hwnd = [int64]$h
      pid = [int]$processId
      title = $title
      titleHit = [bool]$titleHit
      pidHit = [bool]$pidHit
      x = $r.Left; y = $r.Top
      width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top)
    })
    return $true
  }
  $null = [Hud.Win]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

function Get-HudWindow([string]$prefix, [int]$ownerPid, [int]$waitMs) {
  $deadline = (Get-Date).AddMilliseconds($waitMs)
  do {
    $all = @(Find-HudWindows -prefix $prefix -ownerPid $ownerPid)
    if ($all.Count -gt 0) {
      # A window whose title already matches is the HUD itself; prefer it, then the
      # largest area (browser splash windows are small).
      return ($all |
        Sort-Object -Property @{ Expression = { $_.titleHit }; Descending = $true },
                              @{ Expression = { $_.width * $_.height }; Descending = $true } |
        Select-Object -First 1)
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  } while ($true)
  return $null
}

function Get-WorkArea([IntPtr]$h) {
  $mon = [Hud.Win]::MonitorFromWindow($h, 2)
  [Hud.HudMonitorInfo]$mi = New-Object Hud.HudMonitorInfo
  $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
  if ($mon -ne [IntPtr]::Zero -and [Hud.Win]::GetMonitorInfoW($mon, [ref]$mi)) {
    return [pscustomobject]@{
      x = $mi.rcWork.Left; y = $mi.rcWork.Top
      width = ($mi.rcWork.Right - $mi.rcWork.Left)
      height = ($mi.rcWork.Bottom - $mi.rcWork.Top)
    }
  }
  Add-Type -AssemblyName System.Windows.Forms
  $wa = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
  return [pscustomobject]@{ x = $wa.X; y = $wa.Y; width = $wa.Width; height = $wa.Height }
}

function Get-Rect([IntPtr]$h) {
  [Hud.HudRect]$r = New-Object Hud.HudRect
  [void][Hud.Win]::GetWindowRect($h, [ref]$r)
  return [pscustomobject]@{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}

function Test-Topmost([IntPtr]$h) {
  $ex = [Hud.Win]::GetWindowLongW($h, -20)   # GWL_EXSTYLE
  return (($ex -band $WS_EX_TOPMOST) -ne 0)
}

function Send-Ok($data) {
  Write-Output (([ordered]@{ status = 'ok'; data = $data } | ConvertTo-Json -Compress -Depth 6))
}

try {
  $target = Get-HudWindow -prefix $Title -ownerPid $OwnerPid -waitMs $WaitMs
  if ($null -eq $target) {
    if ($Action -eq 'status') { Send-Ok ([ordered]@{ found = $false }); exit 0 }
    throw "HUD window not found (title prefix: $Title, owner pid: $OwnerPid)"
  }
  $h = [IntPtr]$target.hwnd

  if ($Action -eq 'status') {
    Send-Ok ([ordered]@{
      found = $true; hwnd = $target.hwnd; pid = $target.pid; title = $target.title
      rect = (Get-Rect $h); topmost = (Test-Topmost $h); workArea = (Get-WorkArea $h)
    })
    exit 0
  }

  if ($Action -eq 'close') {
    [void][Hud.Win]::SendMessageW($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    Send-Ok ([ordered]@{ closed = $true; hwnd = $target.hwnd })
    exit 0
  }

  if ([Hud.Win]::IsIconic($h)) {
    [void][Hud.Win]::ShowWindow($h, $SW_RESTORE)
    Start-Sleep -Milliseconds 200
  }

  if ($Action -eq 'focus') {
    [void][Hud.Win]::ShowWindow($h, $SW_RESTORE)
    [void][Hud.Win]::SetForegroundWindow($h)
    Send-Ok ([ordered]@{ focused = $true; hwnd = $target.hwnd })
    exit 0
  }

  # pin: dock to the right edge of whichever monitor the window is on.
  $dpi = [Hud.Win]::GetDpiForWindow($h)
  if ($dpi -lt 96) { $dpi = 96 }
  $scale = $dpi / 96.0
  $wa = Get-WorkArea $h
  $mw = [int][Math]::Round($Margin * $scale)
  $w = [int][Math]::Min([int][Math]::Round($Width * $scale), $wa.width - 2 * $mw)
  $hh = [int][Math]::Min([int][Math]::Round($Height * $scale), $wa.height - 2 * $mw)
  $x = $wa.x + $wa.width - $w - $mw
  $y = $wa.y + $mw

  $after = if ($NoTopmost) { $HWND_NOTOPMOST } else { $HWND_TOPMOST }
  $flags = $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW
  if (-not [Hud.Win]::SetWindowPos($h, $after, $x, $y, $w, $hh, $flags)) { throw 'SetWindowPos failed' }
  Start-Sleep -Milliseconds 120
  # Some windows re-assert their own z-order right after a resize; a second pass
  # with the position locked keeps the HUD on top.
  [void][Hud.Win]::SetWindowPos($h, $after, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))

  Send-Ok ([ordered]@{
    hwnd = $target.hwnd; pid = $target.pid; title = $target.title
    rect = (Get-Rect $h); topmost = (Test-Topmost $h); dpi = $dpi
    topmostRequested = (-not $NoTopmost)
  })
}
catch {
  $err = [ordered]@{ status = 'error'; error = ($_.Exception.Message -replace '[^\x20-\x7E]', '?') }
  Write-Output ($err | ConvertTo-Json -Compress)
  exit 1
}

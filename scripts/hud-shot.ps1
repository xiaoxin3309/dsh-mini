# ud-shot.ps1 - screenshot the screen with the DSH HUD kept out of the picture.
#
# The HUD is an Edge/Chrome --app window, so "hide the harness window" would hide
# the wrong thing: what must disappear is the popout itself. This script hides the
# HUD, grabs the whole virtual screen, then puts the HUD back.
#
# Output: one line of JSON.
#   {"status":"ok","data":{"file":"...","bytes":123,"x":..,"y":..,"width":..,"height":..,"hidden":1}}
#   {"status":"error","error":"..."}
#
# ASCII-only source (Windows PowerShell 5.1 reads a BOM-less file as ANSI).

param(
  [string]$Title = '',
  [string]$TitleB64 = '',
  [int]$OwnerPid = 0,
  [Parameter(Mandatory = $true)]
  [string]$OutFile,
  [switch]$KeepHud
)

if (-not [string]::IsNullOrEmpty($TitleB64)) { $Title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TitleB64)) }

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ([System.Management.Automation.PSTypeName]'Hud.ShotWin').Type) {
  # -TypeDefinition (not -MemberDefinition): this block needs `using` directives and
  # top-level structs/delegates, which a member-definition class body cannot hold.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace Hud {
  public delegate bool ShotEnumProc(IntPtr hWnd, IntPtr lParam);

  public static class ShotWin {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(ShotEnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  }
}
'@
}

$SW_HIDE = 0
$SW_SHOWNA = 8
$SWP_NOACTIVATE = 0x0010
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_SHOWWINDOW = 0x0040

function Get-Title([IntPtr]$h) {
  $len = [Hud.ShotWin]::GetWindowTextLengthW($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Hud.ShotWin]::GetWindowTextW($h, $sb, $sb.Capacity)
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
  $script:browserPids = @{}
  foreach ($p in (Get-Process -Name msedge, chrome -ErrorAction SilentlyContinue)) { $script:browserPids[[int]$p.Id] = $p.ProcessName }
  $script:pidsInTree = New-PidTree $ownerPid
  $script:titlePrefix = $prefix
  $script:found = New-Object System.Collections.ArrayList

  $cb = {
    param([IntPtr]$h, [IntPtr]$l)
    if (-not [Hud.ShotWin]::IsWindowVisible($h)) { return $true }
    $processId = [uint32]0
    [void][Hud.ShotWin]::GetWindowThreadProcessId($h, [ref]$processId)
    if (-not $script:browserPids.ContainsKey([int]$processId)) { return $true }

    $title = Get-Title $h
    $titleHit = (-not [string]::IsNullOrWhiteSpace($script:titlePrefix)) -and
      (-not [string]::IsNullOrWhiteSpace($title)) -and $title.StartsWith($script:titlePrefix)
    $pidHit = $script:pidsInTree.ContainsKey([int]$processId)
    if (-not ($titleHit -or $pidHit)) { return $true }

    [void]$script:found.Add([int64]$h)
    return $true
  }
  $null = [Hud.ShotWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

$hidden = New-Object System.Collections.ArrayList
try {
  [void][Hud.ShotWin]::SetProcessDPIAware()

  if (-not $KeepHud) {
    foreach ($hwnd in @(Find-HudWindows -prefix $Title -ownerPid $OwnerPid)) {
      [void][Hud.ShotWin]::ShowWindow([IntPtr]$hwnd, $SW_HIDE)
      [void]$hidden.Add($hwnd)
    }
    if ($hidden.Count -gt 0) { Start-Sleep -Milliseconds 280 }
  }

  $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($v.Width -le 0 -or $v.Height -le 0) { throw "invalid virtual screen $($v.Width)x$($v.Height)" }

  $bmp = New-Object System.Drawing.Bitmap($v.Width, $v.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($v.X, $v.Y, 0, 0, (New-Object System.Drawing.Size($v.Width, $v.Height)), [System.Drawing.CopyPixelOperation]::SourceCopy)
  $g.Dispose()

  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $bytes = (Get-Item $OutFile).Length
  $safePath = $OutFile

  Write-Output (([ordered]@{
    status = 'ok'
    data = [ordered]@{
      file = $safePath; bytes = $bytes
      x = $v.X; y = $v.Y; width = $v.Width; height = $v.Height
      hidden = $hidden.Count
    }
  } | ConvertTo-Json -Compress -Depth 4))
}
catch {
  Write-Output (([ordered]@{ status = 'error'; error = ($_.Exception.Message -replace '[^\x20-\x7E]', '?') } | ConvertTo-Json -Compress))
  exit 1
}
finally {
  # Always bring the HUD back, even when the capture failed.
  foreach ($hwnd in $hidden) {
    $h = [IntPtr]$hwnd
    [void][Hud.ShotWin]::ShowWindow($h, $SW_SHOWNA)
    [void][Hud.ShotWin]::SetWindowPos($h, [IntPtr]0, 0, 0, 0, 0, ($SWP_NOACTIVATE -bor $SWP_SHOWWINDOW -bor $SWP_NOSIZE -bor $SWP_NOMOVE))
  }
}

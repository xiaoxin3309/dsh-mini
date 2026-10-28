param(
    [int]$X1 = 0, [int]$Y1 = 0, [int]$X2 = 0, [int]$Y2 = 0, [int]$Left = -1, [int]$Top = -1,
    [int]$Width = 0, [int]$Height = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Drag -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);
public const uint DOWN = 0x0002;
public const uint UP = 0x0004;
'@

if ($Left -ge 0 -and $Width -gt 0) {
    [void][Drag.U]::SetWindowPos([IntPtr]$env:DRAG_HWND, [IntPtr]::Zero, $Left, $Top, $Width, $Height, 0x0014)
    Start-Sleep -Milliseconds 600
}

[void][Drag.U]::SetCursorPos($X1, $Y1)
Start-Sleep -Milliseconds 200
[Drag.U]::mouse_event([Drag.U]::DOWN, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 160
$steps = 12
for ($i = 1; $i -le $steps; $i++) {
    $x = [int]($X1 + ($X2 - $X1) * $i / $steps)
    $y = [int]($Y1 + ($Y2 - $Y1) * $i / $steps)
    [void][Drag.U]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 120
[Drag.U]::mouse_event([Drag.U]::UP, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
'cursor=' + [System.Windows.Forms.Cursor]::Position

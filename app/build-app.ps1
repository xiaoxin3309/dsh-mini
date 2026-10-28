param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here 'vendor'
$bin = Join-Path $here 'bin'
New-Item -ItemType Directory -Force -Path $vendor, $bin | Out-Null

if ($Clean) {
    Get-ChildItem $bin -File -ErrorAction SilentlyContinue | Remove-Item -Force
}

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

# --- vendor: WebView2 assemblies ---
# Order: app\vendor (committed) -> %TEMP%\wv2 (cache) -> NuGet download.
$wv2Version = '1.0.4314.35'
$wv2root = Join-Path $env:TEMP 'wv2'
$deps = @(
    @{ src = "$wv2root\lib\net462\Microsoft.Web.WebView2.Core.dll";      dst = 'Microsoft.Web.WebView2.Core.dll' },
    @{ src = "$wv2root\lib\net462\Microsoft.Web.WebView2.WinForms.dll"; dst = 'Microsoft.Web.WebView2.WinForms.dll' },
    @{ src = "$wv2root\runtimes\win-x64\native\WebView2Loader.dll";      dst = 'WebView2Loader.dll' }
)

function Test-Cache {
    foreach ($d in $deps) {
        if (-not (Test-Path $d.src)) { return $false }
    }
    return $true
}

$missing = @()
foreach ($d in $deps) {
    if ($Clean -or -not (Test-Path (Join-Path $vendor $d.dst))) { $missing += $d }
}

if ($missing.Count -gt 0 -and -not (Test-Cache)) {
    Write-Output 'WebView2 assemblies not cached - downloading from NuGet...'
    $pkg = Join-Path $env:TEMP ("webview2-" + $wv2Version + ".zip")
    $url = 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/' + $wv2Version
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing
    if (Test-Path $wv2root) { Remove-Item $wv2root -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $wv2root | Out-Null
    Expand-Archive -Path $pkg -DestinationPath $wv2root -Force
    Remove-Item $pkg -Force
    if (-not (Test-Cache)) { throw "WebView2 package did not contain the expected files under $wv2root" }
}

foreach ($d in $missing) {
    Copy-Item $d.src (Join-Path $vendor $d.dst) -Force
}

# --- generate the page-script constant from hud-page.js ---
$jsPath = Join-Path $here 'hud-page.js'
$js = [System.IO.File]::ReadAllText($jsPath, [System.Text.Encoding]::UTF8)
$escaped = $js.Replace('"', '""')
$gen = "namespace DshHud`r`n{`r`n    internal static class HudPage`r`n    {`r`n        internal const string Script = @`"$escaped`";`r`n    }`r`n}`r`n"
[System.IO.File]::WriteAllText((Join-Path $here 'hud-page.g.cs'), $gen, (New-Object System.Text.UTF8Encoding($true)))

# --- compile ---
# Built from code points on purpose: if this file is ever saved without a BOM,
# powershell 5.1 reads it as GBK and a literal '小窗' would become mojibake.
$exeBase = 'DSH' + [char]0x5C0F + [char]0x7A97
$exe = Join-Path $bin ($exeBase + '.exe')
$refs = @(
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Xml.dll'
)

$cscArgs = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/langversion:5')
$cscArgs += ('/out:' + $exe)
$cscArgs += ('/win32manifest:' + (Join-Path $here 'app.manifest'))
foreach ($r in $refs) { $cscArgs += ('/r:' + $r) }
$cscArgs += ('/r:' + (Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'))
$cscArgs += ('/r:' + (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))
# UIA gives us the selection rectangle (and a passive read that needs no Ctrl+C).
$uiaRoot = 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL'
$uiaClient = Join-Path $uiaRoot 'UIAutomationClient\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationClient.dll'
$uiaTypes = Join-Path $uiaRoot 'UIAutomationTypes\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationTypes.dll'
foreach ($uia in @($uiaClient, $uiaTypes)) {
    if (-not (Test-Path $uia)) { throw "UIA assembly missing: $uia" }
    $cscArgs += ('/r:' + $uia)
}
# TextPattern.GetBoundingRectangles returns System.Windows.Rect, so WindowsBase is needed.
$windowsBase = Join-Path $uiaRoot 'WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll'
if (-not (Test-Path $windowsBase)) { throw "WindowsBase missing: $windowsBase" }
$cscArgs += ('/r:' + $windowsBase)
$cscArgs += (Join-Path $here 'HudWindow.cs')
$cscArgs += (Join-Path $here 'SelectionWatcher.cs')
$cscArgs += (Join-Path $here 'Service.cs')
$cscArgs += (Join-Path $here 'RegionCapture.cs')
$cscArgs += (Join-Path $here 'hud-page.g.cs')

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "compile failed with exit code $LASTEXITCODE" }

# --- stage runtime files next to the exe ---
Copy-Item (Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll') $bin -Force
Copy-Item (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll') $bin -Force
Copy-Item (Join-Path $vendor 'WebView2Loader.dll') $bin -Force

Write-Output ''
Write-Output 'build ok:'
Get-ChildItem $bin -File | ForEach-Object { '  ' + $_.Name + '  ' + $_.Length + ' bytes' }

param(
    [switch]$Build,
    [string]$Url = '',
    [string]$Eval = '',
    [int]$WaitSeconds = 9
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'bin\DSH小窗.exe'
$stateDir = Join-Path $env:LOCALAPPDATA 'dsh-hud'

function Get-TokenUrl {
    $body = '{"href":"http://127.0.0.1:58791/"}'
    try {
        $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:58791/dsh-hud/open' `
            -ContentType 'application/json' -Body $body -TimeoutSec 25
        if ($r.url) { return $r.url }
    } catch {
    }
    return ''
}

Get-Process -Name 'DSH小窗' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

if ($Build) {
    $blog = Join-Path $env:TEMP 'build-out.txt'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'build-app.ps1')) `
        -NoNewWindow -Wait -RedirectStandardOutput $blog -RedirectStandardError ($blog + '.err')
    $lines = Get-Content $blog -Encoding Default
    if ($lines -match 'error CS') {
        $lines | Where-Object { $_ -match 'error CS' } | ForEach-Object { Write-Output $_ }
        exit 1
    }
    Write-Output 'build ok'
}

$target = $Url
if ([string]::IsNullOrEmpty($target)) { $target = Get-TokenUrl }
if ([string]::IsNullOrEmpty($target)) {
    Write-Output 'no url: pass -Url or have the dsh-hud-window plugin running'
    exit 1
}

$p = Start-Process -FilePath $exe -ArgumentList @('--url', $target, '--title', 'DSH 小窗', '--debug') -PassThru
Write-Output ('started pid ' + $p.Id)
Start-Sleep -Seconds $WaitSeconds

if (-not [string]::IsNullOrEmpty($Eval)) {
    $js = [System.IO.File]::ReadAllText($Eval, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText((Join-Path $stateDir 'eval.js'), $js, [System.Text.UTF8Encoding]::new($false))
    Start-Sleep -Seconds 3
    $log = Join-Path $stateDir 'hud.log'
    if (Test-Path $log) {
        $t = [System.IO.File]::ReadAllText($log, [System.Text.Encoding]::UTF8)
        Write-Output ('log length: ' + $t.Length)
        if ($t.Length -gt 6000) { Write-Output $t.Substring(0, 6000) } else { Write-Output $t }
    } else {
        Write-Output 'no hud.log'
    }
}

# EA LSX capture: stop the EA background service, run the LSX listener while
# Mirror's Edge Catalyst starts, then restore the service.
#
# Run it from an elevated PowerShell. The script relaunches itself with UAC when
# it is not elevated, so a normal terminal can start it too.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $env:TEMP "efxlve-ea-lsx.log"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell -Verb RunAs -ArgumentList $arguments
    exit
}

"EA LSX capture $(Get-Date -Format o)" | Out-File -FilePath $log -Encoding utf8
$service = Get-Service -Name "EABackgroundService" -ErrorAction SilentlyContinue
$wasRunning = $service -and $service.Status -eq "Running"

try {
    if ($wasRunning) {
        "stopping EABackgroundService" | Out-File -FilePath $log -Append -Encoding utf8
        Stop-Service -Name "EABackgroundService" -Force
        Start-Sleep -Seconds 2
    }
    "service: $((Get-Service -Name EABackgroundService -ErrorAction SilentlyContinue).Status)" |
        Out-File -FilePath $log -Append -Encoding utf8

    $env:EFXLVE_EA_PROBE = "C:\Program Files (x86)\Steam\steamapps\common\Mirrors Edge Catalyst"
    $env:EFXLVE_EA_CONTENT_ID = "1026480"
    $cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (-not (Test-Path $cargo)) {
        $cargo = "cargo.exe"
    }
    "cargo: $cargo" | Out-File -FilePath $log -Append -Encoding utf8
    "cwd: $(Get-Location)" | Out-File -FilePath $log -Append -Encoding utf8
    "manifest: $(Test-Path src-tauri/Cargo.toml)" | Out-File -FilePath $log -Append -Encoding utf8
    & cmd.exe /c "`"$cargo`" test --manifest-path src-tauri/Cargo.toml manual_lsx_catalyst -- --ignored --nocapture >> `"$log`" 2>&1"
    "cargo exit: $LASTEXITCODE" | Out-File -FilePath $log -Append -Encoding utf8
}
finally {
    if ($wasRunning) {
        "restoring EABackgroundService" | Out-File -FilePath $log -Append -Encoding utf8
        Start-Service -Name "EABackgroundService" -ErrorAction SilentlyContinue
    }
    "service: $((Get-Service -Name EABackgroundService -ErrorAction SilentlyContinue).Status)" |
        Out-File -FilePath $log -Append -Encoding utf8
    "done" | Out-File -FilePath $log -Append -Encoding utf8
}

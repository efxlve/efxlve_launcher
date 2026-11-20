# Windows Error Reporting LocalDumps for the launcher: a native fault that never
# reaches crash.log still leaves a dump next to the logs.
#
# Run it from an elevated PowerShell. The script relaunches itself with UAC when
# it is not elevated, so a normal terminal can start it too.
#
# Remove the key when the investigation ends:
#   Remove-Item "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\efxlve-launcher.exe" -Recurse

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell -Verb RunAs -ArgumentList $arguments
    exit
}

$folder = Join-Path $env:LOCALAPPDATA "Efxlve Launcher\crashdumps"
New-Item -ItemType Directory -Force -Path $folder | Out-Null

$key = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\efxlve-launcher.exe"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name "DumpFolder" -PropertyType ExpandString -Value $folder -Force | Out-Null
New-ItemProperty -Path $key -Name "DumpType" -PropertyType DWord -Value 1 -Force | Out-Null # 1 = mini, 2 = full
New-ItemProperty -Path $key -Name "DumpCount" -PropertyType DWord -Value 10 -Force | Out-Null

Write-Host "efxlve-launcher.exe: mini dumps, newest 10 -> $folder"
Write-Host "A process ended with TerminateProcess (Task Manager, an installer) writes no dump;"
Write-Host "this only covers the native fault the app cannot log itself."

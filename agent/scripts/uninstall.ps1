# Removes Self Stream Deck: the start-at-logon task, the Start Menu shortcut, the firewall rules and the program files.
# The data folder (%APPDATA%\SelfStreamDeck: pairing token, certificates) stays unless -RemoveData is given, so a reinstall keeps phones paired.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-RemoveData]

param([switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$TaskName = 'Self Stream Deck'
$Install = Join-Path $env:ProgramFiles 'Self Stream Deck'
$Data = Join-Path $env:APPDATA 'SelfStreamDeck'

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host 'Windows will ask for permission (UAC) to uninstall ...'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" + $(if ($RemoveData) { ' -RemoveData' } else { '' })
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait
    return
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process ssd -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Install*" } | Stop-Process -Force -ErrorAction SilentlyContinue
foreach ($rule in 'Self Stream Deck (rede local)', 'Self Stream Deck (iPhone)') {
    netsh advfirewall firewall delete rule name="$rule" | Out-Null
}
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Self Stream Deck.lnk') -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
# this script may be running from inside the folder it removes: Windows lets the delete finish after it exits
Remove-Item $Install -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveData) { Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "Removed $Data." }
else { Write-Host "Kept $Data (pairing token and certificates); use -RemoveData to delete it too." }
Write-Host 'Uninstalled.'

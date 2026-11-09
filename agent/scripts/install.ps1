# Installs Self Stream Deck from the folder this script is in (the unzipped package): copies ssd.exe to Program Files, brings an earlier
# install's pairing token and certificates along, registers the start-at-logon task (hidden, as administrator) and a Start Menu shortcut.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-From "C:\old\data"] [-NoStart]
#
# Asks for administrator rights once (UAC). Nothing is downloaded: everything is in the package.

param(
    [string]$From = '',      # a data folder of an earlier install (the Node version kept it in legacy\server\data); its token and certificates are copied
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Self Stream Deck'
$Install = Join-Path $env:ProgramFiles 'Self Stream Deck'
$Data = Join-Path $env:APPDATA 'SelfStreamDeck'
$package = $PSScriptRoot

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Path (Join-Path $package 'ssd.exe'))) { throw "ssd.exe is not next to this script ($package)" }

if (-not (Test-Admin)) {
    Write-Host 'Windows will ask for permission (UAC) to install ...'
    # the data folder is the current user's: pass it on, the elevated copy may run as another account in some setups
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" + $(if ($From) { " -From `"$From`"" } else { '' }) + $(if ($NoStart) { ' -NoStart' } else { '' })
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait
    return
}

# an agent that is running holds ssd.exe: end it first (the task, then any process left)
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-Process ssd -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Install*" -or $_.Path -like '*\agent\target*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force $Install | Out-Null
Copy-Item (Join-Path $package 'ssd.exe') $Install -Force
Copy-Item (Join-Path $package 'launch-hidden.vbs') $Install -Force
Copy-Item (Join-Path $package 'uninstall.ps1') $Install -Force
$exe = Join-Path $Install 'ssd.exe'

New-Item -ItemType Directory -Force $Data | Out-Null
if ($From) {
    # copy now so the files are there before the first run (the token never changes, phones stay paired)
    if (-not (Test-Path (Join-Path $Data 'config.json')) -and (Test-Path (Join-Path $From 'config.json'))) {
        Copy-Item (Join-Path $From 'config.json') $Data
        if (Test-Path (Join-Path $From 'tls')) { Copy-Item (Join-Path $From 'tls') $Data -Recurse -Force }
        Write-Host "Brought the pairing token and certificates from $From."
    }
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$launcher = Join-Path $Install 'launch-hidden.vbs'
$taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$launcher`" `"$exe`" `"$Data`"" -WorkingDirectory $Install
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Self Stream Deck agent: starts at logon, hidden, as administrator.' -Force | Out-Null

# a shortcut in the Start Menu that opens the panel (the agent is already running; the tray icon has the same entry)
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Self Stream Deck.lnk'))
$shortcut.TargetPath = 'wscript.exe'
$shortcut.Arguments = "//B //Nologo `"$launcher`" `"$exe`" `"$Data`""
$shortcut.WorkingDirectory = $Install
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = 'Starts the Self Stream Deck agent'
$shortcut.Save()

Write-Host "Installed in $Install (data: $Data)."
if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Started. The icon appears by the clock; right-click it for the pairing code.'
}
Write-Host "Problems? run:  `"$exe`" diagnose"

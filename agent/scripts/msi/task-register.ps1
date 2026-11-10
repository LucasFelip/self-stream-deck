# Run by the MSI (as SYSTEM, after the files are copied): brings an earlier install's token and certificates along, registers the
# "Self Stream Deck" task (starts at logon, hidden, as administrator) for the user who ran the installer, and starts it.
param(
    [Parameter(Mandatory)][string]$Data,   # %APPDATA%\SelfStreamDeck of the installing user
    [Parameter(Mandatory)][string]$User,   # DOMAIN\user
    [string]$From = '',
    [string]$NoStart = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Self Stream Deck'
$install = $PSScriptRoot
$exe = Join-Path $install 'ssd.exe'

New-Item -ItemType Directory -Force $Data | Out-Null
if ($From -and (Test-Path (Join-Path $From 'config.json')) -and -not (Test-Path (Join-Path $Data 'config.json'))) {
    Copy-Item (Join-Path $From 'config.json') $Data
    if (Test-Path (Join-Path $From 'tls')) { Copy-Item (Join-Path $From 'tls') $Data -Recurse -Force }
    Write-Host "Brought the pairing token and certificates from $From."
}

$launcher = Join-Path $install 'launch-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$launcher`" `"$exe`" `"$Data`"" -WorkingDirectory $install
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Self Stream Deck agent: starts at logon, hidden, as administrator.' -Force | Out-Null
Write-Host "Task registered for $User (data: $Data)."

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Started.'
}

# Runs the Rust agent (ssd.exe) at every Windows logon, hidden, with administrator rights. Same task name as the Node agent's, so installing
# this one replaces that one.
#
#   powershell -File agent/scripts/autostart.ps1 -Action install [-StartNow]   register the scheduled task (asks for UAC once)
#   powershell -File agent/scripts/autostart.ps1 -Action uninstall              remove it
#   powershell -File agent/scripts/autostart.ps1 -Action status                 show whether it is registered / running
#
# Administrator rights are needed so keyboard shortcuts also reach elevated windows (Task Manager, an admin terminal), shutdown/restart are
# allowed without extra prompts, and the firewall rules for the phone can be made.
#
# The Node agent has to be stopped first (they use the same ports): end its process, then install and start this one.

param(
    [ValidateSet('install', 'uninstall', 'status')][string]$Action = 'status',
    [switch]$StartNow,
    [string]$Exe = '',
    [string]$DataDir = '',
    [string]$WebDir = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Self Stream Deck'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $Exe) { $Exe = Join-Path $root 'agent\target\release\ssd.exe' }
if (-not $DataDir) { $DataDir = Join-Path $root 'legacy\server\data' }
if (-not $WebDir) { $WebDir = Join-Path $root 'web\dist' }
$launcher = Join-Path $PSScriptRoot 'launch-hidden.vbs'

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Elevated([string]$what) {
    Write-Host "Windows will ask for permission (UAC) to $what ..."
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action $Action -Exe `"$Exe`" -DataDir `"$DataDir`" -WebDir `"$WebDir`"" + $(if ($StartNow) { ' -StartNow' } else { '' })
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait
}

function Show-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "Task '$TaskName': not installed."; return }
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "Task '$TaskName': installed ($($task.State)); last run: $($info.LastRunTime); last result: $($info.LastTaskResult)"
    Write-Host "Runs: $(($task.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join '; ')"
    $port = 7878
    try { $port = (Get-Content (Join-Path $DataDir 'config.json') -Raw | ConvertFrom-Json).port } catch { }
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    Write-Host $(if ($listening) { "Something is listening on port $port." } else { "Nothing is listening on port $port yet." })
}

switch ($Action) {
    'status' { Show-Status }

    'install' {
        if (-not (Test-Path $Exe)) { throw "ssd.exe not found at $Exe (build it: cargo build --release in agent/)" }
        if (-not (Test-Path (Join-Path $WebDir 'index.html'))) { throw "the interface is not built at $WebDir (npm run build in web/)" }
        if (-not (Test-Admin)) { Invoke-Elevated 'register the startup task'; Show-Status; return }

        $user = "$env:USERDOMAIN\$env:USERNAME"
        $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$launcher`" `"$Exe`" `"$DataDir`" `"$WebDir`"" -WorkingDirectory (Split-Path $Exe -Parent)
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings `
            -Description 'Self Stream Deck agent (Rust): starts at logon, hidden, as administrator.' -Force | Out-Null
        Write-Host "Installed. The agent will start at the next logon (log: $DataDir\server.log)."
        if ($StartNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host 'Started now.' }
        Show-Status
    }

    'uninstall' {
        if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Write-Host "Task '$TaskName' is not installed."; return }
        if (-not (Test-Admin)) { Invoke-Elevated 'remove the startup task'; Show-Status; return }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host 'Removed.'
    }
}

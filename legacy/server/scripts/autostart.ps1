# Runs the deck server at every Windows logon, hidden, with administrator rights.
#
#   npm run autostart:install     register the scheduled task (asks for UAC once)
#   npm run autostart:uninstall   remove it
#   npm run autostart:status      show whether it is registered / running
#
# Administrator rights are needed so keyboard shortcuts also reach elevated windows (Task Manager,
# an admin terminal) and so shutdown/restart are allowed without extra prompts.

param(
    [ValidateSet('install', 'uninstall', 'status')][string]$Action = 'status',
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Self Stream Deck'
$serverDir = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $PSScriptRoot 'launch-hidden.vbs'
$configFile = Join-Path $serverDir 'data\config.json'

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Registering a task that runs with the highest privileges needs an elevated shell: ask for it once.
function Invoke-Elevated([string]$what) {
    Write-Host "Windows will ask for permission (UAC) to $what ..."
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action $Action" + $(if ($StartNow) { ' -StartNow' } else { '' })
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait
}

function Show-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "Task '$TaskName': not installed."; return }
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "Task '$TaskName': installed ($($task.State)); last run: $($info.LastRunTime); last result: $($info.LastTaskResult)"
    $port = 7878
    try { $port = (Get-Content $configFile -Raw | ConvertFrom-Json).port } catch { }
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    Write-Host $(if ($listening) { "Server is listening on port $port." } else { "Nothing is listening on port $port yet." })
}

switch ($Action) {
    'status' { Show-Status }

    'install' {
        if (-not (Test-Admin)) { Invoke-Elevated 'register the startup task'; Show-Status; return }

        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $user = "$env:USERDOMAIN\$env:USERNAME"

        $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$launcher`" `"$node`"" -WorkingDirectory $serverDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings `
            -Description 'Self Stream Deck server: starts at logon, hidden, as administrator.' -Force | Out-Null
        Write-Host "Installed. The server will start at the next logon (log: $serverDir\data\server.log)."
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

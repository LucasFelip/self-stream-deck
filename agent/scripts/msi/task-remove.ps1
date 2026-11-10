# Run by the MSI (as SYSTEM) before the files are replaced or removed: stops the agent, removes the startup task and the firewall rules.
# The data folder (pairing token, certificates) is not touched. What it does is printed, so the installer log shows it.
$ErrorActionPreference = 'Continue'

foreach ($step in @(
    { Stop-ScheduledTask -TaskName 'Self Stream Deck' -ErrorAction Stop; 'task stopped' },
    { Unregister-ScheduledTask -TaskName 'Self Stream Deck' -Confirm:$false -ErrorAction Stop; 'task removed' }
)) {
    try { Write-Host (& $step) } catch { Write-Host "task: $($_.Exception.Message)" }
}

# the agent is the only program called ssd.exe; the task's stop does not always end the process it started through wscript and cmd
$killed = taskkill.exe /im ssd.exe /f 2>&1
Write-Host "ssd.exe: $killed"

foreach ($rule in 'Self Stream Deck (rede local)', 'Self Stream Deck (iPhone)') {
    $out = netsh advfirewall firewall delete rule name="$rule" 2>&1
    Write-Host "firewall '$rule': $($out -join ' ')"
}
Start-Sleep -Milliseconds 800
exit 0

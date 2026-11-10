# Run by the MSI (as SYSTEM) before the files are replaced or removed: stops the agent, removes the startup task and the firewall rules.
# The data folder (pairing token, certificates) is not touched.
$ErrorActionPreference = 'SilentlyContinue'
$install = $PSScriptRoot

Stop-ScheduledTask -TaskName 'Self Stream Deck'
Unregister-ScheduledTask -TaskName 'Self Stream Deck' -Confirm:$false
Get-Process ssd | Where-Object { $_.Path -like "$install*" } | Stop-Process -Force
foreach ($rule in 'Self Stream Deck (rede local)', 'Self Stream Deck (iPhone)') {
    netsh advfirewall firewall delete rule name="$rule" | Out-Null
}
Start-Sleep -Milliseconds 500
exit 0

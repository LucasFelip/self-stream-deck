# Notification helper built on the Windows notification listener: the same list as the Action Center, which also
# receives what Do Not Disturb (or a game) kept from popping up.
#
# ops: ping | list
#   list -> { access, notifications: [{ id, aumid, app, title, body, time }] } (newest last)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]

# WinRT async operations -> synchronous results
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(8000)) { throw 'notification operation timed out' }
    $task.Result
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$accessType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]

function Get-Notification($item) {
    $texts = @()
    try {
        foreach ($binding in $item.Notification.Visual.Bindings) {
            foreach ($element in $binding.GetTextElements()) { if ($element.Text) { $texts += [string]$element.Text } }
        }
    }
    catch { }
    $name = $null
    try { $name = $item.AppInfo.DisplayInfo.DisplayName } catch { }
    [ordered]@{
        id    = [uint32]$item.Id
        aumid = [string]$item.AppInfo.AppUserModelId
        app   = $name
        title = if ($texts.Count) { $texts[0] } else { '' }
        body  = ($texts | Select-Object -Skip 1) -join "`n"
        time  = $item.CreationTime.ToUnixTimeMilliseconds()
    }
}

[Console]::Out.WriteLine('{"id":0,"ok":true,"ready":true}')
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $res = @{ id = $id; ok = $true }

        switch ($req.op) {
            'ping' { }

            'list' {
                $access = $listener.GetAccessStatus()
                if ($access -ne 'Allowed') { $access = Await ($listener.RequestAccessAsync()) $accessType }
                $res.access = ([string]$access).ToLowerInvariant()
                $res.notifications = @()
                if ($access -eq 'Allowed') {
                    $items = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType
                    $res.notifications = @($items | Sort-Object CreationTime | ForEach-Object { Get-Notification $_ })
                }
            }

            default { throw "unknown op '$($req.op)'" }
        }
    }
    catch {
        $res = @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $res -Compress -Depth 6))
    [Console]::Out.Flush()
}

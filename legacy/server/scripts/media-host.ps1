# Media helper built on the Windows "System Media Transport Controls": the same source the Windows
# volume flyout uses, so it covers Spotify, YouTube (or any site) in a Chromium browser, VLC, etc.
#
# ops: ping | state | control {session, action, position?} | art {session}
#   actions: toggle | play | pause | next | previous | seek (position in seconds)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

# PowerShell's binder can't pick this extension overload for COM objects, so call it through reflection
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

# WinRT async operations -> synchronous results
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(8000)) { throw 'media operation timed out' }
    $task.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$manager = Await ($managerType::RequestAsync()) $managerType
$sha = [Security.Cryptography.SHA1]::Create()

function Get-Session([string]$sessionId) {
    $found = $manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq $sessionId } | Select-Object -First 1
    if (-not $found) { throw 'media session not found' }
    $found
}

function Get-SessionInfo($session) {
    $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $status = [string]$playback.PlaybackStatus

    $duration = $timeline.EndTime.TotalSeconds - $timeline.StartTime.TotalSeconds
    $position = $timeline.Position.TotalSeconds - $timeline.StartTime.TotalSeconds
    if ($duration -gt 0) {
        # the timeline is a snapshot taken at LastUpdatedTime; move it forward while playing
        if ($status -eq 'Playing') {
            $elapsed = ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds
            if ($elapsed -gt 0) { $position += $elapsed }
        }
        $position = [math]::Max(0, [math]::Min($duration, $position))
    }
    else { $duration = $null; $position = $null }

    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$($session.SourceAppUserModelId)|$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"))
    $controls = $playback.Controls
    [ordered]@{
        id       = $session.SourceAppUserModelId
        title    = $props.Title
        artist   = $props.Artist
        album    = $props.AlbumTitle
        status   = $status.ToLowerInvariant()
        position = $position
        duration = $duration
        canPlay  = [bool]$controls.IsPlayEnabled
        canPause = [bool]$controls.IsPauseEnabled
        canNext  = [bool]$controls.IsNextEnabled
        canPrev  = [bool]$controls.IsPreviousEnabled
        canSeek  = [bool]$controls.IsPlaybackPositionEnabled
        hasArt   = [bool]$props.Thumbnail
        artKey   = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant().Substring(0, 12)
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

            'state' {
                $current = $manager.GetCurrentSession()
                $res.current = if ($current) { $current.SourceAppUserModelId } else { $null }
                $res.sessions = @($manager.GetSessions() | ForEach-Object { Get-SessionInfo $_ })
            }

            'control' {
                $session = Get-Session ([string]$req.session)
                $result = switch ([string]$req.action) {
                    'toggle' { Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
                    'play' { Await ($session.TryPlayAsync()) ([bool]) }
                    'pause' { Await ($session.TryPauseAsync()) ([bool]) }
                    'next' { Await ($session.TrySkipNextAsync()) ([bool]) }
                    'previous' { Await ($session.TrySkipPreviousAsync()) ([bool]) }
                    'seek' {
                        $start = $session.GetTimelineProperties().StartTime.Ticks
                        Await ($session.TryChangePlaybackPositionAsync([long]($start + [double]$req.position * 1e7))) ([bool])
                    }
                    default { throw "unknown action '$($req.action)'" }
                }
                $res.accepted = [bool]$result
            }

            'art' {
                $session = Get-Session ([string]$req.session)
                $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
                $res.data = $null
                if ($props.Thumbnail) {
                    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                    $reader = $asStreamForRead.Invoke($null, @($stream))
                    try {
                        $memory = New-Object IO.MemoryStream
                        $reader.CopyTo($memory)
                        $res.mime = $stream.ContentType
                        $res.data = [Convert]::ToBase64String($memory.ToArray())
                    }
                    finally { $reader.Dispose() } # also closes the underlying WinRT stream
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

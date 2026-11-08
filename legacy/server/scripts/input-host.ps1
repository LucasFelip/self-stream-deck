# Long-lived helper: reads one JSON request per line on stdin, answers with one JSON line on
# stdout. Keeping it alive avoids paying PowerShell + Add-Type startup on every tap.
#
# keys:     keys {vks}
# windows:  windows | focus {name} | windowAction {handle,action} | moveWindow {handle,monitor}
# screens:  monitors {brightness} | setBrightness {device,level} | screensOff
# audio:    getVolume | setVolume {level} | setMute {muted} | toggleMute          (default playback device)
#           devices | setDefaultDevice {id} | setDeviceVolume {id,level} | setDeviceMute {id,muted}
#           sessions | setSessionVolume {pid,level} | setSessionMute {pid,muted}   (per-app mixer)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

. "$PSScriptRoot\lib\cache-type.ps1"

# The C# lives in native/DeckNative.cs, the one copy: the native helper (ssd-helper.exe) is built from the same file.

Add-CachedType -Name 'deck-input' -Path "$PSScriptRoot\..\native\DeckNative.cs"

[DeckNative]::EnableDpiAwareness() # window and monitor rectangles are then in real pixels on every screen

$MM = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio'

function Get-AudioState {
    @{ level = [int][math]::Round([DeckNative]::GetVolume($null) * 100); muted = [DeckNative]::GetMute($null) }
}

# "{0.0.0.00000000}.{guid}" is playback, "{0.0.1.…}" is capture. The friendly name lives in the registry.
function Get-DeviceInfo([string]$id, [string]$defaultId) {
    $flow = if ($id -like '{0.0.1.*') { 'Capture' } else { 'Render' }
    $guid = ($id -split '\}\.', 2)[1]
    $props = Get-ItemProperty "$MM\$flow\$guid\Properties" -ErrorAction SilentlyContinue
    $name = $props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $adapter = $props.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    $info = [ordered]@{ id = $id; name = $(if ($name) { $name } else { $id }); adapter = $adapter; flow = $flow.ToLower(); default = ($id -eq $defaultId); level = $null; muted = $null }
    try {
        $info.level = [int][math]::Round([DeckNative]::GetVolume($id) * 100)
        $info.muted = [DeckNative]::GetMute($id)
    } catch { }
    $info
}

function Get-ProcessLabel([int]$procId) {
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $label = $proc.ProcessName
        try {
            $description = $proc.MainModule.FileVersionInfo.FileDescription
            if ($description) { $label = $description }
        } catch { }
        @{ name = $proc.ProcessName; label = $label }
    } catch { @{ name = "pid$procId"; label = "PID $procId" } }
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
            'keys' { [DeckNative]::Combo([int[]]$req.vks) }

            'getVolume' { $res += Get-AudioState }
            'setVolume' {
                [DeckNative]::SetVolume($null, [float]($req.level / 100))
                # like the Windows slider: raising the volume leaves mute
                if ($req.level -gt 0 -and [DeckNative]::GetMute($null)) { [DeckNative]::SetMute($null, $false) }
                $res += Get-AudioState
            }
            'setMute' { [DeckNative]::SetMute($null, [bool]$req.muted); $res += Get-AudioState }
            'toggleMute' { [DeckNative]::SetMute($null, -not [DeckNative]::GetMute($null)); $res += Get-AudioState }

            # the default recording device, for the header's mic button
            'getMic' {
                try { $res.muted = [DeckNative]::GetMute([DeckNative]::DefaultId(1)); $res.available = $true }
                catch { $res.muted = $false; $res.available = $false }
            }
            'setMic' {
                $mic = [DeckNative]::DefaultId(1)
                $muted = if ([bool]$req.toggle) { -not [DeckNative]::GetMute($mic) } else { [bool]$req.muted }
                [DeckNative]::SetMute($mic, $muted)
                $res.muted = $muted; $res.available = $true
            }

            'devices' {
                $defaults = @{ render = [DeckNative]::DefaultId(0); capture = $null }
                try { $defaults.capture = [DeckNative]::DefaultId(1) } catch { }
                $res.playback = @([DeckNative]::ActiveIds(0) | ForEach-Object { Get-DeviceInfo $_ $defaults.render })
                $res.capture = @([DeckNative]::ActiveIds(1) | ForEach-Object { Get-DeviceInfo $_ $defaults.capture })
            }
            'setDefaultDevice' { [DeckNative]::SetDefault([string]$req.deviceId) }
            'setDeviceVolume' {
                [DeckNative]::SetVolume([string]$req.deviceId, [float]($req.level / 100))
                if ($req.level -gt 0 -and [DeckNative]::GetMute([string]$req.deviceId)) { [DeckNative]::SetMute([string]$req.deviceId, $false) }
            }
            'setDeviceMute' { [DeckNative]::SetMute([string]$req.deviceId, [bool]$req.muted) }

            'sessions' {
                # one entry per process: browsers and games open several audio sessions
                $byPid = @{}
                foreach ($s in [DeckNative]::Sessions()) {
                    if ($s.State -eq 2) { continue } # expired
                    $key = if ($s.System) { 'system' } else { [string]$s.Pid }
                    if (-not $byPid.ContainsKey($key)) {
                        $label = if ($s.System) { @{ name = 'system'; label = 'Sons do sistema' } } else { Get-ProcessLabel $s.Pid }
                        $byPid[$key] = [ordered]@{ pid = [int]$s.Pid; system = [bool]$s.System; name = $label.name; label = $label.label; level = [int][math]::Round($s.Volume * 100); muted = [bool]$s.Muted; active = $false }
                    }
                    if ($s.State -eq 1) { $byPid[$key].active = $true }
                }
                $res.sessions = @($byPid.Values | Sort-Object @{ Expression = { -[int]$_.active } }, label)
            }
            'setSessionVolume' { [DeckNative]::SetSessionVolume([uint32]$req.pid, [bool]$req.system, [float]($req.level / 100)) }
            'setSessionMute' { [DeckNative]::SetSessionMute([uint32]$req.pid, [bool]$req.system, [bool]$req.muted) }

            'windows' {
                $names = @{}
                foreach ($p in [Diagnostics.Process]::GetProcesses()) { $names[$p.Id] = $p.ProcessName }
                $res.running = @($names.Values | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
                $res.windows = @([DeckNative]::Windows() | ForEach-Object {
                    [ordered]@{
                        handle = $_.Handle; pid = [int]$_.Pid; title = $_.Title; state = $_.State; monitor = $_.Monitor
                        x = $_.X; y = $_.Y; w = $_.W; h = $_.H
                        name = $(if ($names.ContainsKey([int]$_.Pid)) { $names[[int]$_.Pid].ToLowerInvariant() } else { '' })
                    }
                })
            }
            # Window actions only apply to a handle that is in the list of windows right now: the phone can't
            # make this process touch an arbitrary window.
            'windowAction' {
                $handle = [long]$req.handle
                if (-not ([DeckNative]::Windows() | Where-Object { $_.Handle -eq $handle })) { throw 'window not found' }
                if ($req.action -eq 'focus') { [DeckNative]::Focus($handle) } else { [DeckNative]::WindowAction($handle, [string]$req.action) }
            }
            'moveWindow' {
                $handle = [long]$req.handle
                if (-not ([DeckNative]::Windows() | Where-Object { $_.Handle -eq $handle })) { throw 'window not found' }
                [DeckNative]::MoveToMonitor($handle, [int]$req.monitor)
            }
            'placeWindow' {
                $handle = [long]$req.handle
                if (-not ([DeckNative]::Windows() | Where-Object { $_.Handle -eq $handle })) { throw 'window not found' }
                [DeckNative]::PlaceWindow($handle, [int]$req.x, [int]$req.y)
            }
            'snapWindow' {
                $handle = [long]$req.handle
                if (-not ([DeckNative]::Windows() | Where-Object { $_.Handle -eq $handle })) { throw 'window not found' }
                [DeckNative]::SnapWindow($handle, [int]$req.monitor, [string]$req.zone)
            }
            'monitors' {
                $res.monitors = @([DeckNative]::Monitors([bool]$req.brightness) | ForEach-Object {
                    [ordered]@{ device = $_.Device; left = $_.Left; top = $_.Top; width = $_.Width; height = $_.Height; primary = $_.Primary; brightness = $(if ($_.Brightness -ge 0) { $_.Brightness } else { $null }) }
                })
            }
            'setBrightness' { [DeckNative]::SetBrightness([string]$req.device, [int]$req.level) }
            'screensOff' { [DeckNative]::ScreensOff() }
            'focus' {
                $target = ([string]$req.name).ToLowerInvariant()
                $pids = @{}
                foreach ($p in [Diagnostics.Process]::GetProcesses()) { if ($p.ProcessName.ToLowerInvariant() -eq $target) { $pids[[uint32]$p.Id] = $true } }
                $window = [DeckNative]::Windows() | Where-Object { $pids.ContainsKey($_.Pid) } | Select-Object -First 1
                if ($window) { [DeckNative]::Focus($window.Handle); $res.focused = $true } else { $res.focused = $false }
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

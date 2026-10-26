# System monitoring helper.
#
# ops: ping | sample | processes | info
#   sample    - live numbers (cpu, memory, gpu, disk, network); cheap, meant to be polled every 1-2 s
#   processes - top processes by cpu and memory
#   info      - static hardware/OS description (slow; cached by the server)
#
# Sources: Windows performance counters, nvidia-smi (if installed) and MSI Afterburner's shared memory
# (if it is running) for CPU temperature/power, which Windows itself does not expose.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Core
Add-Type -AssemblyName System.Windows.Forms

. "$PSScriptRoot\lib\cache-type.ps1"

$memorySource = @'
using System;
using System.Runtime.InteropServices;
public static class MemoryNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX {
        public uint dwLength; public uint dwMemoryLoad;
        public ulong ullTotalPhys; public ulong ullAvailPhys;
        public ulong ullTotalPageFile; public ulong ullAvailPageFile;
        public ulong ullTotalVirtual; public ulong ullAvailVirtual; public ulong ullAvailExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX status);
    public static MEMORYSTATUSEX Read() {
        var s = new MEMORYSTATUSEX();
        s.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        GlobalMemoryStatusEx(ref s);
        return s;
    }
}
'@

Add-CachedType -Name 'deck-monitor' -Source $memorySource

$cores = [Environment]::ProcessorCount
$MB = 1MB

function New-Counter([string]$category, [string]$counter, [string]$instance) {
    try {
        $c = if ($instance) { New-Object Diagnostics.PerformanceCounter $category, $counter, $instance, $true } else { New-Object Diagnostics.PerformanceCounter $category, $counter, '', $true }
        [void]$c.NextValue() # the first reading is always 0
        $c
    } catch { $null }
}

function Read-Counter($c) { if ($c) { try { [double]$c.NextValue() } catch { $null } } else { $null } }
function Round($value, [int]$digits = 1) { if ($null -eq $value) { $null } else { [math]::Round([double]$value, $digits) } }

# --- counters, created once -------------------------------------------------------------------

$cpuTotal = New-Counter 'Processor Information' '% Processor Utility' '_Total'
if (-not $cpuTotal) { $cpuTotal = New-Counter 'Processor' '% Processor Time' '_Total' }
$cpuFreq = New-Counter 'Processor Information' 'Processor Frequency' '_Total'
$cpuCores = @()
try {
    $cpuCores = @((New-Object Diagnostics.PerformanceCounterCategory 'Processor Information').GetInstanceNames() |
        Where-Object { $_ -match '^\d+,\d+$' } | Sort-Object { [int]($_ -split ',')[0] * 1000 + [int]($_ -split ',')[1] } |
        ForEach-Object { New-Counter 'Processor Information' '% Processor Utility' $_ })
} catch { }

$sysProcesses = New-Counter 'System' 'Processes' ''
$sysThreads = New-Counter 'System' 'Threads' ''
$sysUptime = New-Counter 'System' 'System Up Time' ''

$disks = @()
try {
    $disks = @((New-Object Diagnostics.PerformanceCounterCategory 'PhysicalDisk').GetInstanceNames() | ForEach-Object {
        [pscustomobject]@{
            name   = $_
            active = New-Counter 'PhysicalDisk' '% Disk Time' $_
            read   = New-Counter 'PhysicalDisk' 'Disk Read Bytes/sec' $_
            write  = New-Counter 'PhysicalDisk' 'Disk Write Bytes/sec' $_
        }
    })
} catch { }

# physical adapters that are up; their performance-counter instance names are sanitized descriptions
$net = @{ built = [DateTime]::MinValue; adapters = @() }
function Update-NetworkCounters {
    if (([DateTime]::UtcNow - $net.built).TotalSeconds -lt 30) { return }
    $net.built = [DateTime]::UtcNow
    $instances = @()
    try { $instances = (New-Object Diagnostics.PerformanceCounterCategory 'Network Interface').GetInstanceNames() } catch { }
    $net.adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | ForEach-Object {
        $wanted = ($_.InterfaceDescription -replace '\(', '[' -replace '\)', ']' -replace '#', '_' -replace '\\', '_' -replace '/', '_')
        $instance = $instances | Where-Object { $_ -eq $wanted } | Select-Object -First 1
        if ($instance) {
            [pscustomobject]@{
                name = $_.Name; speed = $_.LinkSpeed
                down = New-Counter 'Network Interface' 'Bytes Received/sec' $instance
                up   = New-Counter 'Network Interface' 'Bytes Sent/sec' $instance
            }
        }
    })
}
Update-NetworkCounters

# --- optional sources -------------------------------------------------------------------------

$smiPath = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source
$gpuCache = @{ at = [DateTime]::MinValue; value = $null }

function Read-Gpu {
    if (-not $smiPath) { return $null }
    if (([DateTime]::UtcNow - $gpuCache.at).TotalMilliseconds -lt 1200) { return $gpuCache.value }
    $gpuCache.at = [DateTime]::UtcNow
    try {
        $fields = 'name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,clocks.gr,clocks.max.gr,clocks.mem,pstate,driver_version'
        $row = (& $smiPath "--query-gpu=$fields" '--format=csv,noheader,nounits' | Select-Object -First 1) -split ',\s*'
        $num = { param($v) $x = 0.0; if ([double]::TryParse($v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$x)) { $x } else { $null } }
        $gpuCache.value = [ordered]@{
            source = 'nvidia-smi'; name = $row[0]; temp = (& $num $row[1]); usage = (& $num $row[2])
            memUsedMB = (& $num $row[3]); memTotalMB = (& $num $row[4]); power = (& $num $row[5]); powerLimit = (& $num $row[6])
            fan = (& $num $row[7]); clock = (& $num $row[8]); clockMax = (& $num $row[9]); memClock = (& $num $row[10]); pstate = $row[11]; driver = $row[12]
        }
    } catch { $gpuCache.value = $null }
    $gpuCache.value
}

# MSI Afterburner publishes every sensor it polls in the "MAHMSharedMemory" mapping.
$mahm = @{ view = $null }
function Read-Afterburner {
    try {
        if (-not $mahm.view) {
            $file = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('MAHMSharedMemory', [IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
            $mahm.view = $file.CreateViewAccessor(0, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        }
        $v = $mahm.view
        if ($v.ReadUInt32(0) -ne 0x4D41484D) { throw 'bad signature' }
        $header = $v.ReadUInt32(8); $count = $v.ReadUInt32(12); $size = $v.ReadUInt32(16)
        $values = @{}
        $buffer = New-Object byte[] 260
        for ($i = 0; $i -lt $count; $i++) {
            $offset = $header + $i * $size
            [void]$v.ReadArray($offset, $buffer, 0, 260)
            $name = [Text.Encoding]::ASCII.GetString($buffer).Split([char]0)[0]
            $data = $v.ReadSingle($offset + 1300)
            if ([single]::IsNaN($data) -or [math]::Abs($data) -gt 1e9) { continue }
            $values[$name] = [double]$data
        }
        $values
    } catch { $mahm.view = $null; $null }
}

# RivaTuner Statistics Server (installed with Afterburner) hooks running games and publishes each one's frame
# counters in the "RTSSSharedMemoryV2" mapping. An entry that has not drawn a frame for 2 s is not a game being played.
$rtss = @{ view = $null }
function Read-Fps {
    try {
        if (-not $rtss.view) {
            $file = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('RTSSSharedMemoryV2', [IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
            $rtss.view = $file.CreateViewAccessor(0, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        }
        $v = $rtss.view
        if ($v.ReadUInt32(0) -ne 0x52545353) { throw 'bad signature' }
        $entrySize = $v.ReadUInt32(8); $arrayOffset = $v.ReadUInt32(12); $count = [math]::Min($v.ReadUInt32(16), 256)
        if ($entrySize -lt 284) { return $null }
        $now = [int64][BitConverter]::ToUInt32([BitConverter]::GetBytes([Environment]::TickCount), 0)
        $buffer = New-Object byte[] 260
        $best = $null
        for ($i = 0; $i -lt $count; $i++) {
            $offset = $arrayOffset + $i * $entrySize
            if ($v.ReadUInt32($offset) -eq 0) { continue }
            $time0 = [int64]$v.ReadUInt32($offset + 268); $time1 = [int64]$v.ReadUInt32($offset + 272)
            $frames = $v.ReadUInt32($offset + 276); $frameTimeUs = $v.ReadUInt32($offset + 280)
            $age = ($now - $time1 + 4294967296) % 4294967296
            $span = ($time1 - $time0 + 4294967296) % 4294967296
            if ($age -gt 2000) { continue }
            $fps = if ($span -gt 0 -and $frames -gt 0) { 1000.0 * $frames / $span } elseif ($frameTimeUs -gt 0) { 1e6 / $frameTimeUs } else { 0 }
            if ($fps -le 0) { continue }
            if ($best -and $best.age -le $age) { continue }
            [void]$v.ReadArray($offset + 4, $buffer, 0, 260)
            $path = [Text.Encoding]::ASCII.GetString($buffer).Split([char]0)[0]
            $best = @{ age = $age; value = [ordered]@{
                source = 'RTSS'; app = [IO.Path]::GetFileNameWithoutExtension($path); fps = (Round $fps 0)
                frameMs = $(if ($frameTimeUs -gt 0) { Round ($frameTimeUs / 1000.0) 1 } else { Round (1000.0 / $fps) 1 })
            } }
        }
        if ($best) { $best.value } else { $null }
    } catch { $rtss.view = $null; $null }
}

# --- processes --------------------------------------------------------------------------------

$cpuSeconds = @{} # pid -> cpu seconds at the previous call
$lastProcessCall = [DateTime]::UtcNow

function Read-TopProcesses {
    $now = [DateTime]::UtcNow
    $elapsed = [math]::Max(0.2, ($now - $lastProcessCall).TotalSeconds)
    $script:lastProcessCall = $now
    $byName = @{}
    $seen = @{}
    foreach ($p in [Diagnostics.Process]::GetProcesses()) {
        $cpu = 0.0
        try { $cpu = $p.TotalProcessorTime.TotalSeconds } catch { }
        $delta = if ($cpuSeconds.ContainsKey($p.Id)) { [math]::Max(0, $cpu - $cpuSeconds[$p.Id]) } else { 0 }
        $cpuSeconds[$p.Id] = $cpu
        $seen[$p.Id] = $true
        if ($p.Id -eq 0) { continue } # idle
        $name = $p.ProcessName
        if (-not $byName.ContainsKey($name)) { $byName[$name] = @{ name = $name; cpu = 0.0; mem = 0.0; count = 0 } }
        $byName[$name].cpu += $delta / $elapsed / $cores * 100
        $byName[$name].mem += $p.WorkingSet64 / $MB
        $byName[$name].count += 1
    }
    foreach ($key in @($cpuSeconds.Keys)) { if (-not $seen.ContainsKey($key)) { $cpuSeconds.Remove($key) } }
    $all = @($byName.Values)
    @{
        cpu = @($all | Sort-Object { -$_.cpu } | Select-Object -First 6 | ForEach-Object { [ordered]@{ name = $_.name; cpu = (Round $_.cpu); memMB = (Round $_.mem 0); count = $_.count } })
        mem = @($all | Sort-Object { -$_.mem } | Select-Object -First 6 | ForEach-Object { [ordered]@{ name = $_.name; cpu = (Round $_.cpu); memMB = (Round $_.mem 0); count = $_.count } })
    }
}
[void](Read-TopProcesses) # primes the cpu baseline

# --- static info ------------------------------------------------------------------------------

function Try-Get([scriptblock]$block) { try { & $block } catch { $null } }

# ConvertTo-Json writes DateTime as "\/Date(…)\/" in Windows PowerShell 5.1; ISO strings are what clients expect
function Iso($date) { if ($date -is [DateTime]) { $date.ToString('o') } else { $null } }

function Get-SystemInfo {
    $os = Try-Get { Get-CimInstance Win32_OperatingSystem }
    $cpu = Try-Get { Get-CimInstance Win32_Processor | Select-Object -First 1 }
    $board = Try-Get { Get-CimInstance Win32_BaseBoard }
    $bios = Try-Get { Get-CimInstance Win32_BIOS }
    $modules = @(Try-Get { Get-CimInstance Win32_PhysicalMemory })
    $memoryTypes = @{ 20 = 'DDR'; 21 = 'DDR2'; 24 = 'DDR3'; 26 = 'DDR4'; 34 = 'DDR5' }

    $gpus = @()
    $classKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    $registryGpus = @(Try-Get { Get-ChildItem $classKey -ErrorAction Stop | ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } | Where-Object { $_.DriverDesc } })
    foreach ($video in @(Try-Get { Get-CimInstance Win32_VideoController })) {
        # Win32_VideoController.AdapterRAM is a 32-bit number (caps at 4 GB); the registry has the real size
        $reg = $registryGpus | Where-Object { $_.DriverDesc -eq $video.Name } | Select-Object -First 1
        $vram = if ($reg -and $reg.'HardwareInformation.qwMemorySize') { [double]$reg.'HardwareInformation.qwMemorySize' } else { [double]$video.AdapterRAM }
        $gpus += [ordered]@{ name = $video.Name; driver = $video.DriverVersion; vramGB = (Round ($vram / 1GB) 1); refreshHz = $video.CurrentRefreshRate }
    }

    $storage = @(Try-Get { Get-PhysicalDisk | ForEach-Object { [ordered]@{ id = [string]$_.DeviceId; model = $_.FriendlyName; sizeGB = (Round ($_.Size / 1GB) 0); type = [string]$_.MediaType; bus = [string]$_.BusType; health = [string]$_.HealthStatus } } })
    $drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' } | ForEach-Object {
        $part = Try-Get { Get-Partition -DriveLetter $_.Name.Substring(0, 1) -ErrorAction Stop | Select-Object -First 1 }
        [ordered]@{ name = $_.Name.TrimEnd('\'); disk = if ($part) { [string]$part.DiskNumber } else { $null }; label = $_.VolumeLabel; fs = $_.DriveFormat; totalGB = (Round ($_.TotalSize / 1GB) 0); freeGB = (Round ($_.AvailableFreeSpace / 1GB) 0) }
    })

    $adapters = @(Try-Get {
        Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
            $ip = Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
            [ordered]@{ name = $_.Name; description = $_.InterfaceDescription; speed = $_.LinkSpeed; mac = $_.MacAddress; ip = $ip.IPAddress }
        }
    })

    $monitors = @([Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [ordered]@{ name = ($_.DeviceName -replace '^\\\\\.\\', ''); width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary }
    })

    [ordered]@{
        host     = $env:COMPUTERNAME
        user     = $env:USERNAME
        os       = [ordered]@{ name = $os.Caption; version = $os.Version; build = $os.BuildNumber; arch = $os.OSArchitecture; installed = (Iso $os.InstallDate); lastBoot = (Iso $os.LastBootUpTime) }
        cpu      = [ordered]@{ name = ($cpu.Name -replace '\s+', ' ').Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; maxMHz = $cpu.MaxClockSpeed; l2KB = $cpu.L2CacheSize; l3KB = $cpu.L3CacheSize; socket = $cpu.SocketDesignation }
        memory   = [ordered]@{
            totalGB = (Round (($modules | Measure-Object Capacity -Sum).Sum / 1GB) 0)
            modules = @($modules | ForEach-Object { [ordered]@{ slot = $_.DeviceLocator; sizeGB = (Round ($_.Capacity / 1GB) 0); speed = $_.ConfiguredClockSpeed; type = $(if ($memoryTypes.ContainsKey([int]$_.SMBIOSMemoryType)) { $memoryTypes[[int]$_.SMBIOSMemoryType] } else { '' }); maker = $_.Manufacturer; part = ([string]$_.PartNumber).Trim() } })
        }
        gpus     = $gpus
        board    = [ordered]@{ maker = $board.Manufacturer; model = $board.Product; bios = $bios.SMBIOSBIOSVersion; biosDate = (Iso $bios.ReleaseDate) }
        storage  = $storage
        drives   = $drives
        network  = $adapters
        monitors = $monitors
    }
}

# --- main loop --------------------------------------------------------------------------------

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

            'sample' {
                Update-NetworkCounters
                $mem = [MemoryNative]::Read()
                $sensors = Read-Afterburner
                $coreUsage = @($cpuCores | ForEach-Object { Round ([math]::Min(100, (Read-Counter $_))) 0 })

                $res.cpu = [ordered]@{
                    usage      = (Round ([math]::Min(100, (Read-Counter $cpuTotal))))
                    cores      = $coreUsage
                    # the Windows counter reports the nominal clock; Afterburner has the live boost clock
                    freqMHz    = $(if ($sensors -and $sensors.ContainsKey('CPU clock')) { Round $sensors['CPU clock'] 0 } else { Round (Read-Counter $cpuFreq) 0 })
                    temp       =$(if ($sensors) { Round $sensors['CPU temperature'] } else { $null })
                    power      = $(if ($sensors) { Round $sensors['CPU power'] } else { $null })
                    tempSource = $(if ($sensors -and $sensors.ContainsKey('CPU temperature')) { 'MSI Afterburner' } else { $null })
                    processes  = [int](Read-Counter $sysProcesses)
                    threads    = [int](Read-Counter $sysThreads)
                }
                $res.memory = [ordered]@{
                    totalMB       = (Round ($mem.ullTotalPhys / $MB) 0)
                    usedMB        = (Round (($mem.ullTotalPhys - $mem.ullAvailPhys) / $MB) 0)
                    usedPct       = [int]$mem.dwMemoryLoad
                    commitUsedMB  = (Round (($mem.ullTotalPageFile - $mem.ullAvailPageFile) / $MB) 0)
                    commitLimitMB = (Round ($mem.ullTotalPageFile / $MB) 0)
                }
                $res.gpu = Read-Gpu
                $res.fps = Read-Fps
                if (-not $res.fps -and $sensors -and $sensors['Framerate'] -gt 0) {
                    $res.fps = [ordered]@{ source = 'MSI Afterburner'; app = $null; fps = (Round $sensors['Framerate'] 0); frameMs = (Round (1000.0 / $sensors['Framerate']) 1) }
                }
                $res.disk = [ordered]@{
                    disks  = @($disks | Where-Object { $_.name -ne '_Total' } | ForEach-Object { [ordered]@{ name = $_.name; active = (Round ([math]::Min(100, (Read-Counter $_.active))) 0); readBps = (Round (Read-Counter $_.read) 0); writeBps = (Round (Read-Counter $_.write) 0) } })
                    total  = $(
                        $all = $disks | Where-Object { $_.name -eq '_Total' } | Select-Object -First 1
                        if ($all) { [ordered]@{ active = (Round ([math]::Min(100, (Read-Counter $all.active))) 0); readBps = (Round (Read-Counter $all.read) 0); writeBps = (Round (Read-Counter $all.write) 0) } } else { $null }
                    )
                    drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' } | ForEach-Object {
                        [ordered]@{ name = $_.Name.TrimEnd('\'); label = $_.VolumeLabel; totalGB = (Round ($_.TotalSize / 1GB) 0); freeGB = (Round ($_.AvailableFreeSpace / 1GB) 1) } })
                }
                $res.network = @($net.adapters | ForEach-Object { [ordered]@{ name = $_.name; speed = $_.speed; downBps = (Round (Read-Counter $_.down) 0); upBps = (Round (Read-Counter $_.up) 0) } })
                $res.uptime = (Round (Read-Counter $sysUptime) 0)
            }

            # just the frame rate (a read of shared memory), so the phone can notice a game without sampling every counter
            'fps' {
                $res.fps = Read-Fps
                if (-not $res.fps) {
                    $sensors = Read-Afterburner
                    if ($sensors -and $sensors['Framerate'] -gt 0) {
                        $res.fps = [ordered]@{ source = 'MSI Afterburner'; app = $null; fps = (Round $sensors['Framerate'] 0); frameMs = (Round (1000.0 / $sensors['Framerate']) 1) }
                    }
                }
            }

            'processes' { $res.top = Read-TopProcesses }
            'info' { $res.info = Get-SystemInfo }

            default { throw "unknown op '$($req.op)'" }
        }
    }
    catch {
        $res = @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $res -Compress -Depth 8))
    [Console]::Out.Flush()
}

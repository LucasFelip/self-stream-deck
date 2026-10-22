using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Linq;
using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

// "monitor" helper: the numbers behind the Performance, Processes and "About this PC" pages. Same operations as
// scripts/monitor-host.ps1: Windows performance counters, nvidia-smi, MSI Afterburner / RTSS shared memory and WMI.
static class MonitorOps {
    const double MB = 1048576.0;
    const double GB = 1073741824.0;
    static readonly int Cores = Environment.ProcessorCount;

    // --- helpers -------------------------------------------------------------------------------------------

    static object Round(double? value, int digits) {
        return value.HasValue ? (object)Math.Round(value.Value, digits, MidpointRounding.AwayFromZero) : null;
    }

    static object Round(double value, int digits) { return Math.Round(value, digits, MidpointRounding.AwayFromZero); }

    static double? Min100(double? value) { return value.HasValue ? (double?)Math.Min(100, value.Value) : null; }

    // --- counters (PDH): one query for everything, collected every second -------------------------------------------

    static Pdh pdh;
    static bool initialised;

    class AdapterCounters { public string Name, Speed, Instance; }
    static List<AdapterCounters> adapters = new List<AdapterCounters>();
    static DateTime adaptersBuilt = DateTime.MinValue;
    static bool utilityCounters;

    static void Init() {
        if (initialised) return;
        initialised = true;
        pdh = new Pdh();
        utilityCounters = pdh.Add("cores", @"\Processor Information(*)\% Processor Utility");
        if (!utilityCounters) pdh.Add("cores", @"\Processor(*)\% Processor Time");
        pdh.Add("freq", @"\Processor Information(_Total)\Processor Frequency");
        pdh.Add("processes", @"\System\Processes");
        pdh.Add("threads", @"\System\Threads");
        pdh.Add("uptime", @"\System\System Up Time");
        pdh.Add("diskActive", @"\PhysicalDisk(*)\% Disk Time");
        pdh.Add("diskRead", @"\PhysicalDisk(*)\Disk Read Bytes/sec");
        pdh.Add("diskWrite", @"\PhysicalDisk(*)\Disk Write Bytes/sec");
        pdh.Add("netDown", @"\Network Interface(*)\Bytes Received/sec");
        pdh.Add("netUp", @"\Network Interface(*)\Bytes Sent/sec");
        pdh.Start();
        ReadTopProcesses(); // primes the cpu baseline
        pdh.WaitForRates(2500); // rates need two collections: a second after the first
    }

    static double? Pick(string key, string instance) {
        double value;
        return pdh.Instances(key).TryGetValue(instance, out value) ? (double?)value : null;
    }

    // total and per-core usage: "0,3" (group,core) instances of Processor Information, or "3" of the old Processor object
    static List<double> CoreUsage() {
        var pattern = new Regex(utilityCounters ? @"^\d+,\d+$" : @"^\d+$");
        return pdh.Instances("cores").Where(p => pattern.IsMatch(p.Key))
            .OrderBy(p => p.Key.Contains(",") ? int.Parse(p.Key.Split(',')[0]) * 1000 + int.Parse(p.Key.Split(',')[1]) : int.Parse(p.Key))
            .Select(p => p.Value).ToList();
    }


    // --- network adapters (physical, up) ---------------------------------------------------------------------

    static string LinkSpeed(ulong bitsPerSecond) {
        if (bitsPerSecond == 0) return "0 bps";
        if (bitsPerSecond >= 1000000000UL) return Trim(bitsPerSecond / 1e9) + " Gbps";
        if (bitsPerSecond >= 1000000UL) return Trim(bitsPerSecond / 1e6) + " Mbps";
        if (bitsPerSecond >= 1000UL) return Trim(bitsPerSecond / 1e3) + " Kbps";
        return bitsPerSecond + " bps";
    }

    static string Trim(double value) { return value.ToString("0.##", CultureInfo.InvariantCulture); }

    class PhysicalAdapter { public string Name, Description, Speed, Mac; public uint Index; }

    static List<PhysicalAdapter> PhysicalAdapters() {
        var list = new List<PhysicalAdapter>();
        try {
            var scope = new ManagementScope(@"\\.\ROOT\StandardCimv2");
            var query = new ObjectQuery("SELECT Name, InterfaceDescription, InterfaceIndex, InterfaceOperationalStatus, Speed, HardwareInterface, PermanentAddress FROM MSFT_NetAdapter WHERE HardwareInterface = TRUE");
            using (var search = new ManagementObjectSearcher(scope, query)) {
                foreach (ManagementObject adapter in search.Get()) {
                    if (Convert.ToInt32(adapter["InterfaceOperationalStatus"], CultureInfo.InvariantCulture) != 1) continue; // 1 = up
                    string mac = Convert.ToString(adapter["PermanentAddress"], CultureInfo.InvariantCulture) ?? "";
                    if (mac.Length == 12) mac = string.Join("-", Enumerable.Range(0, 6).Select(i => mac.Substring(i * 2, 2)));
                    list.Add(new PhysicalAdapter {
                        Name = (string)adapter["Name"],
                        Description = (string)adapter["InterfaceDescription"],
                        Speed = LinkSpeed(Convert.ToUInt64(adapter["Speed"], CultureInfo.InvariantCulture)),
                        Mac = mac,
                        Index = Convert.ToUInt32(adapter["InterfaceIndex"], CultureInfo.InvariantCulture),
                    });
                }
            }
        } catch (Exception) { }
        return list;
    }

    static void UpdateNetworkCounters() {
        if ((DateTime.UtcNow - adaptersBuilt).TotalSeconds < 30) return;
        adaptersBuilt = DateTime.UtcNow;
        var instances = pdh.Instances("netDown").Keys.ToList();
        var fresh = new List<AdapterCounters>();
        foreach (var a in PhysicalAdapters()) {
            // counter instance names are the adapter descriptions with these characters replaced
            string wanted = a.Description.Replace('(', '[').Replace(')', ']').Replace('#', '_').Replace('\\', '_').Replace('/', '_');
            string instance = instances.FirstOrDefault(i => i == wanted);
            if (instance != null) fresh.Add(new AdapterCounters { Name = a.Name, Speed = a.Speed, Instance = instance });
        }
        adapters = fresh;
    }


    // --- nvidia-smi ---------------------------------------------------------------------------------------------

    static string smiPath;
    static bool smiSearched;
    static DateTime gpuAt = DateTime.MinValue;
    static Dictionary<string, object> gpuValue;

    static string FindSmi() {
        if (smiSearched) return smiPath;
        smiSearched = true;
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
            try {
                if (dir.Length == 0) continue;
                string candidate = Path.Combine(dir.Trim('"'), "nvidia-smi.exe");
                if (File.Exists(candidate)) { smiPath = candidate; break; }
            } catch (Exception) { }
        }
        return smiPath;
    }

    static object Number(string text) {
        double value;
        return double.TryParse((text ?? "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out value) ? (object)value : null;
    }

    static Dictionary<string, object> ReadGpu() {
        string smi = FindSmi();
        if (smi == null) return null;
        if ((DateTime.UtcNow - gpuAt).TotalMilliseconds < 1200) return gpuValue;
        gpuAt = DateTime.UtcNow;
        try {
            const string fields = "name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,clocks.gr,clocks.max.gr,clocks.mem,pstate,driver_version";
            var info = new ProcessStartInfo(smi, "--query-gpu=" + fields + " --format=csv,noheader,nounits") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            };
            using (var process = Process.Start(info)) {
                string output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(5000);
                string line = output.Split('\n')[0].Trim();
                string[] row = Regex.Split(line, @",\s*");
                if (row.Length < 13) { gpuValue = null; return null; }
                var gpu = new Dictionary<string, object>();
                gpu["source"] = "nvidia-smi";
                gpu["name"] = row[0];
                gpu["temp"] = Number(row[1]);
                gpu["usage"] = Number(row[2]);
                gpu["memUsedMB"] = Number(row[3]);
                gpu["memTotalMB"] = Number(row[4]);
                gpu["power"] = Number(row[5]);
                gpu["powerLimit"] = Number(row[6]);
                gpu["fan"] = Number(row[7]);
                gpu["clock"] = Number(row[8]);
                gpu["clockMax"] = Number(row[9]);
                gpu["memClock"] = Number(row[10]);
                gpu["pstate"] = row[11];
                gpu["driver"] = row[12];
                gpuValue = gpu;
            }
        } catch (Exception) { gpuValue = null; }
        return gpuValue;
    }

    // --- MSI Afterburner (MAHMSharedMemory) and RivaTuner (RTSSSharedMemoryV2) ----------------------------------

    static MemoryMappedViewAccessor mahm, rtss;

    static MemoryMappedViewAccessor Open(string name) {
        var file = MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.Read);
        return file.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
    }

    static string AsciiZ(byte[] buffer) {
        int end = Array.IndexOf(buffer, (byte)0);
        return Encoding.ASCII.GetString(buffer, 0, end < 0 ? buffer.Length : end);
    }

    static Dictionary<string, double> ReadAfterburner() {
        try {
            if (mahm == null) mahm = Open("MAHMSharedMemory");
            if (mahm.ReadUInt32(0) != 0x4D41484D) throw new Exception("bad signature");
            uint header = mahm.ReadUInt32(8), count = mahm.ReadUInt32(12), size = mahm.ReadUInt32(16);
            var values = new Dictionary<string, double>();
            var buffer = new byte[260];
            for (uint i = 0; i < count; i++) {
                long offset = header + (long)i * size;
                mahm.ReadArray(offset, buffer, 0, 260);
                string name = AsciiZ(buffer);
                float data = mahm.ReadSingle(offset + 1300);
                if (float.IsNaN(data) || Math.Abs(data) > 1e9) continue;
                values[name] = data;
            }
            return values;
        } catch (Exception) { mahm = null; return null; }
    }

    static Dictionary<string, object> ReadFps() {
        try {
            if (rtss == null) rtss = Open("RTSSSharedMemoryV2");
            if (rtss.ReadUInt32(0) != 0x52545353) throw new Exception("bad signature");
            uint entrySize = rtss.ReadUInt32(8), arrayOffset = rtss.ReadUInt32(12), count = Math.Min(rtss.ReadUInt32(16), 256u);
            if (entrySize < 284) return null;
            long now = (uint)Environment.TickCount;
            var buffer = new byte[260];
            long bestAge = long.MaxValue;
            Dictionary<string, object> best = null;
            for (uint i = 0; i < count; i++) {
                long offset = arrayOffset + (long)i * entrySize;
                if (rtss.ReadUInt32(offset) == 0) continue;
                long time0 = rtss.ReadUInt32(offset + 268), time1 = rtss.ReadUInt32(offset + 272);
                uint frames = rtss.ReadUInt32(offset + 276), frameTimeUs = rtss.ReadUInt32(offset + 280);
                long age = (now - time1 + 4294967296L) % 4294967296L;
                long span = (time1 - time0 + 4294967296L) % 4294967296L;
                if (age > 2000) continue;
                double fps = span > 0 && frames > 0 ? 1000.0 * frames / span : (frameTimeUs > 0 ? 1e6 / frameTimeUs : 0);
                if (fps <= 0) continue;
                if (best != null && bestAge <= age) continue;
                rtss.ReadArray(offset + 4, buffer, 0, 260);
                var entry = new Dictionary<string, object>();
                entry["source"] = "RTSS";
                entry["app"] = Path.GetFileNameWithoutExtension(AsciiZ(buffer));
                entry["fps"] = Round(fps, 0);
                entry["frameMs"] = Round(frameTimeUs > 0 ? frameTimeUs / 1000.0 : 1000.0 / fps, 1);
                best = entry;
                bestAge = age;
            }
            return best;
        } catch (Exception) { rtss = null; return null; }
    }

    // --- memory ---------------------------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORYSTATUSEX {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX status);

    // --- processes --------------------------------------------------------------------------------------------------

    static readonly Dictionary<int, double> cpuSeconds = new Dictionary<int, double>(); // pid -> cpu seconds at the previous call
    static DateTime lastProcessCall = DateTime.UtcNow;

    class Group { public string Name; public double Cpu, Mem; public int Count; }

    static Dictionary<string, object> ReadTopProcesses() {
        DateTime now = DateTime.UtcNow;
        double elapsed = Math.Max(0.2, (now - lastProcessCall).TotalSeconds);
        lastProcessCall = now;
        var byName = new Dictionary<string, Group>();
        var seen = new HashSet<int>();
        foreach (var p in Process.GetProcesses()) {
            using (p) {
                double cpu = 0;
                try { cpu = p.TotalProcessorTime.TotalSeconds; } catch (Exception) { }
                double previous;
                double delta = cpuSeconds.TryGetValue(p.Id, out previous) ? Math.Max(0, cpu - previous) : 0;
                cpuSeconds[p.Id] = cpu;
                seen.Add(p.Id);
                if (p.Id == 0) continue; // idle
                string name = p.ProcessName;
                Group group;
                if (!byName.TryGetValue(name, out group)) { group = new Group { Name = name }; byName[name] = group; }
                group.Cpu += delta / elapsed / Cores * 100;
                try { group.Mem += p.WorkingSet64 / MB; } catch (Exception) { }
                group.Count += 1;
            }
        }
        foreach (int key in cpuSeconds.Keys.ToList()) if (!seen.Contains(key)) cpuSeconds.Remove(key);

        Func<Group, object> row = g => {
            var entry = new Dictionary<string, object>();
            entry["name"] = g.Name;
            entry["cpu"] = Round(g.Cpu, 1);
            entry["memMB"] = Round(g.Mem, 0);
            entry["count"] = g.Count;
            return entry;
        };
        var all = byName.Values.ToList();
        var top = new Dictionary<string, object>();
        top["cpu"] = all.OrderByDescending(g => g.Cpu).Take(6).Select(row).ToList();
        top["mem"] = all.OrderByDescending(g => g.Mem).Take(6).Select(row).ToList();
        return top;
    }

    // --- static info (About this PC) -----------------------------------------------------------------------------

    static List<ManagementBaseObject> Wmi(string query, string scope) {
        var list = new List<ManagementBaseObject>();
        try {
            using (var search = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(query))) {
                foreach (ManagementBaseObject item in search.Get()) list.Add(item);
            }
        } catch (Exception) { }
        return list;
    }

    static List<ManagementBaseObject> Cim(string query) { return Wmi(query, @"\\.\ROOT\CIMV2"); }

    static object Prop(ManagementBaseObject item, string name) {
        try { return item == null ? null : item[name]; } catch (Exception) { return null; }
    }

    static object Iso(object cimDate) {
        string text = cimDate as string;
        if (string.IsNullOrEmpty(text)) return null;
        try { return DateTime.SpecifyKind(ManagementDateTimeConverter.ToDateTime(text), DateTimeKind.Local).ToString("o"); } catch (Exception) { return null; }
    }

    static double D(object value) {
        try { return value == null ? 0 : Convert.ToDouble(value, CultureInfo.InvariantCulture); } catch (Exception) { return 0; }
    }

    static readonly Dictionary<int, string> MemoryTypes = new Dictionary<int, string> { { 20, "DDR" }, { 21, "DDR2" }, { 24, "DDR3" }, { 26, "DDR4" }, { 34, "DDR5" } };
    static readonly Dictionary<int, string> MediaTypes = new Dictionary<int, string> { { 0, "Unspecified" }, { 3, "HDD" }, { 4, "SSD" }, { 5, "SCM" } };
    static readonly Dictionary<int, string> BusTypes = new Dictionary<int, string> {
        { 0, "Unknown" }, { 1, "SCSI" }, { 2, "ATAPI" }, { 3, "ATA" }, { 4, "1394" }, { 5, "SSA" }, { 6, "Fibre Channel" }, { 7, "USB" }, { 8, "RAID" },
        { 9, "iSCSI" }, { 10, "SAS" }, { 11, "SATA" }, { 12, "SD" }, { 13, "MMC" }, { 14, "MAX" }, { 15, "File Backed Virtual" }, { 16, "Storage Spaces" }, { 17, "NVMe" },
    };
    static readonly Dictionary<int, string> Health = new Dictionary<int, string> { { 0, "Healthy" }, { 1, "Warning" }, { 2, "Unhealthy" }, { 5, "Unknown" } };

    static string Lookup(Dictionary<int, string> map, object value) {
        int key;
        try { key = Convert.ToInt32(value, CultureInfo.InvariantCulture); } catch (Exception) { return ""; }
        string text;
        return map.TryGetValue(key, out text) ? text : key.ToString(CultureInfo.InvariantCulture);
    }

    static Dictionary<string, object> SystemInfo() {
        var os = Cim("SELECT Caption, Version, BuildNumber, OSArchitecture, InstallDate, LastBootUpTime FROM Win32_OperatingSystem").FirstOrDefault();
        var cpu = Cim("SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, L2CacheSize, L3CacheSize, SocketDesignation FROM Win32_Processor").FirstOrDefault();
        var board = Cim("SELECT Manufacturer, Product FROM Win32_BaseBoard").FirstOrDefault();
        var bios = Cim("SELECT SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS").FirstOrDefault();
        var modules = Cim("SELECT DeviceLocator, Capacity, ConfiguredClockSpeed, SMBIOSMemoryType, Manufacturer, PartNumber FROM Win32_PhysicalMemory");

        // Win32_VideoController.AdapterRAM is a 32-bit number (caps at 4 GB); the registry has the real size
        var registryGpus = new List<KeyValuePair<string, double>>();
        try {
            using (var classKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}")) {
                if (classKey != null) {
                    foreach (string sub in classKey.GetSubKeyNames()) {
                        try {
                            using (var key = classKey.OpenSubKey(sub)) {
                                string desc = key == null ? null : key.GetValue("DriverDesc") as string;
                                if (string.IsNullOrEmpty(desc)) continue;
                                object raw = key.GetValue("HardwareInformation.qwMemorySize");
                                double size = raw is long ? (long)raw : (raw is byte[] && ((byte[])raw).Length >= 8 ? BitConverter.ToInt64((byte[])raw, 0) : 0);
                                registryGpus.Add(new KeyValuePair<string, double>(desc, size));
                            }
                        } catch (Exception) { }
                    }
                }
            }
        } catch (Exception) { }

        var gpus = new List<object>();
        foreach (var video in Cim("SELECT Name, DriverVersion, AdapterRAM, CurrentRefreshRate FROM Win32_VideoController")) {
            string name = Prop(video, "Name") as string;
            var match = registryGpus.FirstOrDefault(g => g.Key == name);
            double vram = match.Key != null && match.Value > 0 ? match.Value : D(Prop(video, "AdapterRAM"));
            var gpu = new Dictionary<string, object>();
            gpu["name"] = name;
            gpu["driver"] = Prop(video, "DriverVersion");
            gpu["vramGB"] = Round(vram / GB, 1);
            gpu["refreshHz"] = Prop(video, "CurrentRefreshRate");
            gpus.Add(gpu);
        }

        var storage = new List<object>();
        foreach (var disk in Wmi("SELECT FriendlyName, Size, MediaType, BusType, HealthStatus FROM MSFT_PhysicalDisk", @"\\.\ROOT\Microsoft\Windows\Storage")) {
            var entry = new Dictionary<string, object>();
            entry["model"] = Prop(disk, "FriendlyName");
            entry["sizeGB"] = Round(D(Prop(disk, "Size")) / GB, 0);
            entry["type"] = Lookup(MediaTypes, Prop(disk, "MediaType"));
            entry["bus"] = Lookup(BusTypes, Prop(disk, "BusType"));
            entry["health"] = Lookup(Health, Prop(disk, "HealthStatus"));
            storage.Add(entry);
        }

        var drives = new List<object>();
        foreach (var drive in DriveInfo.GetDrives()) {
            if (!drive.IsReady || drive.DriveType != DriveType.Fixed) continue;
            var entry = new Dictionary<string, object>();
            entry["name"] = drive.Name.TrimEnd('\\');
            entry["label"] = drive.VolumeLabel;
            entry["fs"] = drive.DriveFormat;
            entry["totalGB"] = Round(drive.TotalSize / GB, 0);
            entry["freeGB"] = Round(drive.AvailableFreeSpace / GB, 0);
            drives.Add(entry);
        }

        var network = new List<object>();
        var interfaces = NetworkInterface.GetAllNetworkInterfaces();
        foreach (var adapter in PhysicalAdapters()) {
            string ip = null;
            foreach (var ni in interfaces) {
                try {
                    var v4 = ni.GetIPProperties().GetIPv4Properties();
                    if (v4 == null || v4.Index != adapter.Index) continue;
                    var address = ni.GetIPProperties().UnicastAddresses.FirstOrDefault(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork);
                    if (address != null) ip = address.Address.ToString();
                } catch (Exception) { }
            }
            var entry = new Dictionary<string, object>();
            entry["name"] = adapter.Name;
            entry["description"] = adapter.Description;
            entry["speed"] = adapter.Speed;
            entry["mac"] = adapter.Mac;
            entry["ip"] = ip;
            network.Add(entry);
        }

        var monitors = new List<object>();
        foreach (var screen in System.Windows.Forms.Screen.AllScreens) {
            var entry = new Dictionary<string, object>();
            entry["name"] = Regex.Replace(screen.DeviceName, @"^\\\\\.\\", "");
            entry["width"] = screen.Bounds.Width;
            entry["height"] = screen.Bounds.Height;
            entry["primary"] = screen.Primary;
            monitors.Add(entry);
        }

        var memoryModules = new List<object>();
        double totalBytes = 0;
        foreach (var module in modules) {
            double capacity = D(Prop(module, "Capacity"));
            totalBytes += capacity;
            var entry = new Dictionary<string, object>();
            entry["slot"] = Prop(module, "DeviceLocator");
            entry["sizeGB"] = Round(capacity / GB, 0);
            entry["speed"] = Prop(module, "ConfiguredClockSpeed");
            string type;
            entry["type"] = MemoryTypes.TryGetValue((int)D(Prop(module, "SMBIOSMemoryType")), out type) ? type : "";
            entry["maker"] = Prop(module, "Manufacturer");
            entry["part"] = ((Prop(module, "PartNumber") as string) ?? "").Trim();
            memoryModules.Add(entry);
        }

        var info = new Dictionary<string, object>();
        info["host"] = Environment.MachineName.ToUpperInvariant();
        info["user"] = Environment.UserName;
        var osInfo = new Dictionary<string, object>();
        osInfo["name"] = Prop(os, "Caption");
        osInfo["version"] = Prop(os, "Version");
        osInfo["build"] = Prop(os, "BuildNumber");
        osInfo["arch"] = Prop(os, "OSArchitecture");
        osInfo["installed"] = Iso(Prop(os, "InstallDate"));
        osInfo["lastBoot"] = Iso(Prop(os, "LastBootUpTime"));
        info["os"] = osInfo;
        var cpuInfo = new Dictionary<string, object>();
        cpuInfo["name"] = Regex.Replace((Prop(cpu, "Name") as string) ?? "", @"\s+", " ").Trim();
        cpuInfo["cores"] = Prop(cpu, "NumberOfCores");
        cpuInfo["threads"] = Prop(cpu, "NumberOfLogicalProcessors");
        cpuInfo["maxMHz"] = Prop(cpu, "MaxClockSpeed");
        cpuInfo["l2KB"] = Prop(cpu, "L2CacheSize");
        cpuInfo["l3KB"] = Prop(cpu, "L3CacheSize");
        cpuInfo["socket"] = Prop(cpu, "SocketDesignation");
        info["cpu"] = cpuInfo;
        var memoryInfo = new Dictionary<string, object>();
        memoryInfo["totalGB"] = Round(totalBytes / GB, 0);
        memoryInfo["modules"] = memoryModules;
        info["memory"] = memoryInfo;
        info["gpus"] = gpus;
        var boardInfo = new Dictionary<string, object>();
        boardInfo["maker"] = Prop(board, "Manufacturer");
        boardInfo["model"] = Prop(board, "Product");
        boardInfo["bios"] = Prop(bios, "SMBIOSBIOSVersion");
        boardInfo["biosDate"] = Iso(Prop(bios, "ReleaseDate"));
        info["board"] = boardInfo;
        info["storage"] = storage;
        info["drives"] = drives;
        info["network"] = network;
        info["monitors"] = monitors;
        return info;
    }

    // --- operations -------------------------------------------------------------------------------------------------

    static Dictionary<string, object> Sample() {
        Init();
        UpdateNetworkCounters();
        var memory = new MEMORYSTATUSEX();
        memory.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        GlobalMemoryStatusEx(ref memory);
        var sensors = ReadAfterburner();
        Func<string, double?> sensor = key => {
            double value;
            return sensors != null && sensors.TryGetValue(key, out value) ? (double?)value : null;
        };

        var result = HostLoop.Ok();

        var cpu = new Dictionary<string, object>();
        var cores = CoreUsage();
        cpu["usage"] = Round(Min100(Pick("cores", "_Total")), 1);
        cpu["cores"] = cores.Select(c => Round(Min100(c), 0)).ToList();
        // the Windows counter reports the nominal clock; Afterburner has the live boost clock
        cpu["freqMHz"] = sensor("CPU clock").HasValue ? Round(sensor("CPU clock"), 0) : Round(Pick("freq", "_Total"), 0);
        cpu["temp"] = sensors != null ? Round(sensor("CPU temperature"), 1) : null;
        cpu["power"] = sensors != null ? Round(sensor("CPU power"), 1) : null;
        cpu["tempSource"] = sensor("CPU temperature").HasValue ? "MSI Afterburner" : null;
        cpu["processes"] = (int)(pdh.Value("processes") ?? 0);
        cpu["threads"] = (int)(pdh.Value("threads") ?? 0);
        result["cpu"] = cpu;

        var mem = new Dictionary<string, object>();
        mem["totalMB"] = Round(memory.ullTotalPhys / MB, 0);
        mem["usedMB"] = Round((memory.ullTotalPhys - memory.ullAvailPhys) / MB, 0);
        mem["usedPct"] = (int)memory.dwMemoryLoad;
        mem["commitUsedMB"] = Round((memory.ullTotalPageFile - memory.ullAvailPageFile) / MB, 0);
        mem["commitLimitMB"] = Round(memory.ullTotalPageFile / MB, 0);
        result["memory"] = mem;

        result["gpu"] = ReadGpu();
        var fps = ReadFps();
        if (fps == null && sensor("Framerate").HasValue && sensor("Framerate").Value > 0) {
            fps = new Dictionary<string, object>();
            fps["source"] = "MSI Afterburner";
            fps["app"] = null;
            fps["fps"] = Round(sensor("Framerate"), 0);
            fps["frameMs"] = Round(1000.0 / sensor("Framerate").Value, 1);
        }
        result["fps"] = fps;

        Func<string, Dictionary<string, object>> diskRow = name => {
            var entry = new Dictionary<string, object>();
            entry["active"] = Round(Min100(Pick("diskActive", name)), 0);
            entry["readBps"] = Round(Pick("diskRead", name), 0);
            entry["writeBps"] = Round(Pick("diskWrite", name), 0);
            return entry;
        };
        var disk = new Dictionary<string, object>();
        var diskNames = pdh.Instances("diskActive").Keys.Where(n => n != "_Total").ToList();
        disk["disks"] = diskNames.Select(name => {
            var named = new Dictionary<string, object>();
            named["name"] = name;
            foreach (var pair in diskRow(name)) named[pair.Key] = pair.Value;
            return (object)named;
        }).ToList();
        disk["total"] = pdh.Instances("diskActive").ContainsKey("_Total") ? diskRow("_Total") : null;
        var drives = new List<object>();
        foreach (var drive in DriveInfo.GetDrives()) {
            if (!drive.IsReady || drive.DriveType != DriveType.Fixed) continue;
            var entry = new Dictionary<string, object>();
            entry["name"] = drive.Name.TrimEnd('\\');
            entry["label"] = drive.VolumeLabel;
            entry["totalGB"] = Round(drive.TotalSize / GB, 0);
            entry["freeGB"] = Round(drive.AvailableFreeSpace / GB, 1);
            drives.Add(entry);
        }
        disk["drives"] = drives;
        result["disk"] = disk;

        result["network"] = adapters.Select(a => {
            var entry = new Dictionary<string, object>();
            entry["name"] = a.Name;
            entry["speed"] = a.Speed;
            entry["downBps"] = Round(Pick("netDown", a.Instance), 0);
            entry["upBps"] = Round(Pick("netUp", a.Instance), 0);
            return (object)entry;
        }).ToList();
        result["uptime"] = Round(pdh.Value("uptime"), 0);
        return result;
    }

    public static void Register(HostLoop host) {
        host.On("ping", r => HostLoop.Ok());
        host.On("sample", r => Sample());
        host.On("processes", r => {
            Init();
            var result = HostLoop.Ok();
            result["top"] = ReadTopProcesses();
            return result;
        });
        host.On("info", r => {
            var result = HostLoop.Ok();
            result["info"] = SystemInfo();
            return result;
        });
    }
}

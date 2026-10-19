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

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

// Undocumented but stable since Windows 7: the interface Windows' own Sound control panel uses to change the default device.
[Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr format);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool isDefault, IntPtr format);
    [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr endpointFormat, IntPtr mixFormat);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool isDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr period);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr mode);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr mode);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool fx, IntPtr key, IntPtr value);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool fx, IntPtr key, IntPtr value);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string name, int role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool visible);
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
class PolicyConfigClient { }

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, uint streamFlags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, uint streamFlags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    [PreserveSig] int RegisterSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
    [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
    [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession(); // S_OK = system sounds, S_FALSE = regular session
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

public class SessionInfo {
    public uint Pid;
    public bool System;
    public int State;
    public float Volume;
    public bool Muted;
}

public class WindowInfo {
    public long Handle;
    public uint Pid;
    public string Title;
    public int State;   // 0 normal, 1 minimized, 2 maximized
    public int Monitor; // index into Monitors(), -1 if unknown
    public int X, Y, W, H; // visible rectangle in virtual-desktop pixels (0 when minimized)
}

public class MonitorInfo {
    public string Device;
    public int Left, Top, Width, Height;
    public bool Primary;
    public int Brightness = -1; // percent, -1 when the monitor does not answer DDC/CI
}

public static class DeckNative {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowRect(IntPtr hWnd, int attribute, out RECT value, int size);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1, CharSet = CharSet.Unicode)]
    struct PHYSICAL_MONITOR {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription;
    }

    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
    [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
    [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr hPhysical, out uint min, out uint current, out uint max);
    [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr hPhysical, uint brightness);
    [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitor(IntPtr hPhysical);

    // --- audio endpoints ------------------------------------------------------

    static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }

    static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); }

    static IMMDevice DefaultDevice(int flow) {
        IMMDevice device;
        Check(Enumerator().GetDefaultAudioEndpoint(flow, 1, out device)); // eMultimedia
        return device;
    }

    static IMMDevice DeviceById(string id) {
        IMMDevice device;
        Check(Enumerator().GetDevice(id, out device));
        return device;
    }

    static T Activate<T>(IMMDevice device) {
        Guid iid = typeof(T).GUID;
        object result;
        Check(device.Activate(ref iid, 23, IntPtr.Zero, out result)); // CLSCTX_ALL
        return (T)result;
    }

    static string IdOf(IMMDevice device) { string id; Check(device.GetId(out id)); return id; }

    public static string DefaultId(int flow) { return IdOf(DefaultDevice(flow)); }

    // flow: 0 = playback, 1 = capture. Only active devices (the registry also keeps unplugged ones).
    public static string[] ActiveIds(int flow) {
        IMMDeviceCollection collection;
        Check(Enumerator().EnumAudioEndpoints(flow, 1, out collection));
        uint count;
        Check(collection.GetCount(out count));
        var ids = new string[count];
        for (uint i = 0; i < count; i++) {
            IMMDevice device;
            Check(collection.Item(i, out device));
            ids[i] = IdOf(device);
        }
        return ids;
    }

    static IAudioEndpointVolume Volume(string id) {
        // PowerShell turns $null into "" for string parameters, so both mean "the default playback device"
        return Activate<IAudioEndpointVolume>(string.IsNullOrEmpty(id) ? DefaultDevice(0) : DeviceById(id));
    }

    public static float GetVolume(string id) { float v; Check(Volume(id).GetMasterVolumeLevelScalar(out v)); return v; }

    public static void SetVolume(string id, float level) {
        Guid ctx = Guid.Empty;
        Check(Volume(id).SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, level)), ref ctx));
    }

    public static bool GetMute(string id) { bool m; Check(Volume(id).GetMute(out m)); return m; }

    public static void SetMute(string id, bool mute) { Guid ctx = Guid.Empty; Check(Volume(id).SetMute(mute, ref ctx)); }

    public static void SetDefault(string id) {
        var policy = (IPolicyConfig)new PolicyConfigClient();
        // console + multimedia, exactly what "Set as Default Device" does in the Sound control panel;
        // the separate "communications" default (role 2) is left alone.
        for (int role = 0; role < 2; role++) Check(policy.SetDefaultEndpoint(id, role));
    }

    // --- per-application volume ----------------------------------------------

    static List<object> RawSessions() {
        var manager = Activate<IAudioSessionManager2>(DefaultDevice(0));
        IAudioSessionEnumerator sessions;
        Check(manager.GetSessionEnumerator(out sessions));
        int count;
        Check(sessions.GetCount(out count));
        var list = new List<object>();
        for (int i = 0; i < count; i++) {
            object session;
            Check(sessions.GetSession(i, out session));
            list.Add(session);
        }
        return list;
    }

    public static SessionInfo[] Sessions() {
        var result = new List<SessionInfo>();
        foreach (var raw in RawSessions()) {
            var control = (IAudioSessionControl2)raw;
            var volume = (ISimpleAudioVolume)raw;
            var info = new SessionInfo();
            control.GetProcessId(out info.Pid);
            info.System = control.IsSystemSoundsSession() == 0;
            control.GetState(out info.State);
            volume.GetMasterVolume(out info.Volume);
            volume.GetMute(out info.Muted);
            result.Add(info);
        }
        return result.ToArray();
    }

    static void EachSession(uint pid, bool system, Action<ISimpleAudioVolume> action) {
        foreach (var raw in RawSessions()) {
            var control = (IAudioSessionControl2)raw;
            uint sessionPid;
            control.GetProcessId(out sessionPid);
            bool isSystem = control.IsSystemSoundsSession() == 0;
            if (system ? isSystem : (!isSystem && sessionPid == pid)) action((ISimpleAudioVolume)raw);
        }
    }

    public static void SetSessionVolume(uint pid, bool system, float level) {
        Guid ctx = Guid.Empty;
        float clamped = Math.Max(0f, Math.Min(1f, level));
        EachSession(pid, system, delegate (ISimpleAudioVolume v) {
            Check(v.SetMasterVolume(clamped, ref ctx));
            if (clamped > 0f) Check(v.SetMute(false, ref ctx));
        });
    }

    public static void SetSessionMute(uint pid, bool system, bool mute) {
        Guid ctx = Guid.Empty;
        EachSession(pid, system, delegate (ISimpleAudioVolume v) { Check(v.SetMute(mute, ref ctx)); });
    }

    // --- keyboard -------------------------------------------------------------

    static bool IsExtended(int vk) {
        return (vk >= 0x21 && vk <= 0x28)   // page up/down, end, home, arrows
            || vk == 0x2C || vk == 0x2D || vk == 0x2E   // print screen, insert, delete
            || vk == 0x5B || vk == 0x5C                 // windows keys
            || (vk >= 0xA6 && vk <= 0xB7);              // browser, volume and media keys
    }

    static void Send(int vk, bool up) {
        uint flags = (IsExtended(vk) ? 1u : 0u) | (up ? 2u : 0u);
        keybd_event((byte)vk, 0, flags, UIntPtr.Zero);
    }

    // Presses every key in order, then releases them in reverse, e.g. ctrl, shift, esc.
    public static void Combo(int[] vks) {
        int pressed = 0;
        try {
            foreach (int vk in vks) { Send(vk, false); pressed++; Thread.Sleep(8); }
            Thread.Sleep(20);
        } finally {
            for (int i = pressed - 1; i >= 0; i--) { Send(vks[i], true); Thread.Sleep(8); }
        }
    }

    // --- windows --------------------------------------------------------------

    // Top-level windows a user would see in Alt+Tab: visible, titled, not tool windows, not cloaked.
    public static WindowInfo[] Windows() {
        var list = new List<WindowInfo>();
        var devices = MonitorDevices();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd) || GetWindowTextLength(hWnd) == 0) return true;
            int exStyle = GetWindowLong(hWnd, -20);
            bool toolWindow = (exStyle & 0x80) != 0 && (exStyle & 0x40000) == 0;
            if (toolWindow || GetWindow(hWnd, 4) != IntPtr.Zero) return true; // GW_OWNER
            int cloaked;
            if (DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;

            var title = new System.Text.StringBuilder(256);
            GetWindowText(hWnd, title, title.Capacity);
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var window = new WindowInfo { Handle = hWnd.ToInt64(), Pid = pid, Title = title.ToString() };
            window.State = IsIconic(hWnd) ? 1 : (IsZoomed(hWnd) ? 2 : 0);
            if (window.State != 1) {
                RECT frame;
                if (VisibleFrame(hWnd, out frame)) {
                    window.X = frame.Left; window.Y = frame.Top;
                    window.W = frame.Right - frame.Left; window.H = frame.Bottom - frame.Top;
                }
            }
            window.Monitor = Array.IndexOf(devices, DeviceOf(MonitorFromWindow(hWnd, 2))); // 2 = nearest
            list.Add(window);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static void Focus(long handle) {
        IntPtr hWnd = new IntPtr(handle);
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
        // A tap on Alt lets this background process take the foreground (Windows blocks it otherwise).
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hWnd);
    }

    // The caller (PowerShell) has already checked that the handle is a window we listed.
    public static void WindowAction(long handle, string action) {
        IntPtr hWnd = new IntPtr(handle);
        switch (action) {
            case "minimize": ShowWindow(hWnd, 6); break;   // SW_MINIMIZE
            case "maximize": ShowWindow(hWnd, 3); break;   // SW_MAXIMIZE
            case "restore": ShowWindow(hWnd, 9); break;    // SW_RESTORE
            case "close": PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero); break; // WM_CLOSE: the app may ask to save
            default: throw new ArgumentException("unknown window action " + action);
        }
    }

    // --- monitors -------------------------------------------------------------

    // Always sorted by device name (\\.\DISPLAY1, \\.\DISPLAY2...), so an index means the same thing everywhere.
    static List<KeyValuePair<IntPtr, MONITORINFOEX>> EnumerateMonitors() {
        var found = new List<KeyValuePair<IntPtr, MONITORINFOEX>>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data) {
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMonitor, ref info)) found.Add(new KeyValuePair<IntPtr, MONITORINFOEX>(hMonitor, info));
            return true;
        }, IntPtr.Zero);
        found.Sort(delegate (KeyValuePair<IntPtr, MONITORINFOEX> a, KeyValuePair<IntPtr, MONITORINFOEX> b) { return string.CompareOrdinal(a.Value.szDevice, b.Value.szDevice); });
        return found;
    }

    static string[] MonitorDevices() {
        var all = EnumerateMonitors();
        var names = new string[all.Count];
        for (int i = 0; i < names.Length; i++) names[i] = all[i].Value.szDevice;
        return names;
    }

    static string DeviceOf(IntPtr hMonitor) {
        var info = new MONITORINFOEX();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        return GetMonitorInfo(hMonitor, ref info) ? info.szDevice : "";
    }

    public static void EnableDpiAwareness() { SetProcessDPIAware(); } // so every rectangle is in real pixels

    // Brightness comes from DDC/CI, which is slow (tens of ms per monitor): ask for it only when needed.
    public static MonitorInfo[] Monitors(bool withBrightness) {
        var result = new List<MonitorInfo>();
        foreach (var entry in EnumerateMonitors()) {
            var info = entry.Value;
            var monitor = new MonitorInfo {
                Device = info.szDevice,
                Left = info.rcMonitor.Left, Top = info.rcMonitor.Top,
                Width = info.rcMonitor.Right - info.rcMonitor.Left, Height = info.rcMonitor.Bottom - info.rcMonitor.Top,
                Primary = (info.dwFlags & 1) != 0
            };
            if (withBrightness) {
                uint count;
                if (GetNumberOfPhysicalMonitorsFromHMONITOR(entry.Key, out count) && count > 0) {
                    var physical = new PHYSICAL_MONITOR[count];
                    GetPhysicalMonitorsFromHMONITOR(entry.Key, count, physical);
                    uint min, current, max;
                    if (GetMonitorBrightness(physical[0].hPhysicalMonitor, out min, out current, out max) && max > min)
                        monitor.Brightness = (int)Math.Round((current - min) * 100.0 / (max - min));
                    foreach (var p in physical) DestroyPhysicalMonitor(p.hPhysicalMonitor);
                }
            }
            result.Add(monitor);
        }
        return result.ToArray();
    }

    public static void SetBrightness(string device, int percent) {
        foreach (var entry in EnumerateMonitors()) {
            if (entry.Value.szDevice != device) continue;
            uint count;
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(entry.Key, out count) || count == 0) throw new InvalidOperationException("monitor does not support brightness control");
            var physical = new PHYSICAL_MONITOR[count];
            GetPhysicalMonitorsFromHMONITOR(entry.Key, count, physical);
            try {
                uint min, current, max;
                if (!GetMonitorBrightness(physical[0].hPhysicalMonitor, out min, out current, out max) || max <= min) throw new InvalidOperationException("monitor does not support brightness control");
                uint target = (uint)(min + Math.Round((max - min) * Math.Max(0, Math.Min(100, percent)) / 100.0));
                if (!SetMonitorBrightness(physical[0].hPhysicalMonitor, target)) throw new InvalidOperationException("monitor refused the brightness change");
            } finally {
                foreach (var p in physical) DestroyPhysicalMonitor(p.hPhysicalMonitor);
            }
            return;
        }
        throw new ArgumentException("unknown monitor " + device);
    }

    // SC_MONITORPOWER 2 = off; moving the mouse wakes the screens again.
    public static void ScreensOff() { PostMessage(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(2)); }

    // The rectangle the user sees. GetWindowRect also includes the invisible resize borders Windows 10/11 adds.
    static bool VisibleFrame(IntPtr hWnd, out RECT frame) {
        if (DwmGetWindowRect(hWnd, 9, out frame, Marshal.SizeOf(typeof(RECT))) == 0) return true; // DWMWA_EXTENDED_FRAME_BOUNDS
        return GetWindowRect(hWnd, out frame);
    }

    // Positions a window so that its *visible* rectangle is exactly x, y, w, h.
    static void SetVisibleRect(IntPtr hWnd, int x, int y, int w, int h) {
        RECT win, frame;
        GetWindowRect(hWnd, out win);
        VisibleFrame(hWnd, out frame);
        int left = frame.Left - win.Left, top = frame.Top - win.Top, right = win.Right - frame.Right, bottom = win.Bottom - frame.Bottom;
        SetWindowPos(hWnd, IntPtr.Zero, x - left, y - top, w + left + right, h + top + bottom, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
    }

    // Moves a normal window so its top-left corner is at x, y (virtual-desktop pixels). Maximized windows move
    // with MoveToMonitor. The corner is clamped so a grabbable part of the window always stays on a screen.
    public static void PlaceWindow(long handle, int x, int y) {
        IntPtr hWnd = new IntPtr(handle);
        if (IsZoomed(hWnd) || IsIconic(hWnd)) return;
        RECT frame;
        if (!VisibleFrame(hWnd, out frame)) return;
        int w = frame.Right - frame.Left, h = frame.Bottom - frame.Top;

        int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
        foreach (var m in EnumerateMonitors()) {
            minX = Math.Min(minX, m.Value.rcWork.Left); minY = Math.Min(minY, m.Value.rcWork.Top);
            maxX = Math.Max(maxX, m.Value.rcWork.Right); maxY = Math.Max(maxY, m.Value.rcWork.Bottom);
        }
        x = Math.Max(minX - w + 120, Math.Min(x, maxX - 120));
        y = Math.Max(minY, Math.Min(y, maxY - 60));
        SetVisibleRect(hWnd, x, y, w, h);
    }

    // zone: "left" or "right" half of the monitor's work area, or "full" (maximized on that monitor).
    public static void SnapWindow(long handle, int monitorIndex, string zone) {
        var monitors = EnumerateMonitors();
        if (monitorIndex < 0 || monitorIndex >= monitors.Count) throw new ArgumentException("unknown monitor index");
        IntPtr hWnd = new IntPtr(handle);
        var work = monitors[monitorIndex].Value.rcWork;

        if (zone == "full") {
            MoveToMonitor(handle, monitorIndex);
            ShowWindow(hWnd, 3); // SW_MAXIMIZE
            return;
        }
        if (zone != "left" && zone != "right") throw new ArgumentException("unknown snap zone " + zone);

        if (IsZoomed(hWnd) || IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
        int width = work.Right - work.Left, height = work.Bottom - work.Top, half = width / 2;
        SetVisibleRect(hWnd, zone == "left" ? work.Left : work.Left + half, work.Top, zone == "left" ? half : width - half, height);
    }

    // Moves a window to another monitor keeping its relative position and (if it fits) its size.
    public static void MoveToMonitor(long handle, int target) {
        var monitors = EnumerateMonitors();
        if (target < 0 || target >= monitors.Count) throw new ArgumentException("unknown monitor index");
        IntPtr hWnd = new IntPtr(handle);

        var from = new MONITORINFOEX();
        from.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        GetMonitorInfo(MonitorFromWindow(hWnd, 2), ref from);
        var to = monitors[target].Value;
        if (from.szDevice == to.szDevice) return;

        bool maximized = IsZoomed(hWnd);
        if (maximized || IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE, so we move its normal rectangle

        RECT r;
        GetWindowRect(hWnd, out r);
        int fromW = Math.Max(1, from.rcWork.Right - from.rcWork.Left), fromH = Math.Max(1, from.rcWork.Bottom - from.rcWork.Top);
        int toW = to.rcWork.Right - to.rcWork.Left, toH = to.rcWork.Bottom - to.rcWork.Top;
        int width = Math.Min(r.Right - r.Left, toW), height = Math.Min(r.Bottom - r.Top, toH);
        int x = to.rcWork.Left + (int)((r.Left - from.rcWork.Left) / (double)fromW * toW);
        int y = to.rcWork.Top + (int)((r.Top - from.rcWork.Top) / (double)fromH * toH);
        x = Math.Max(to.rcWork.Left, Math.Min(x, to.rcWork.Right - width));
        y = Math.Max(to.rcWork.Top, Math.Min(y, to.rcWork.Bottom - height));
        SetWindowPos(hWnd, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
        if (maximized) ShowWindow(hWnd, 3);
    }
}
'@

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

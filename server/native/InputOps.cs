using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using Microsoft.Win32;

// "input" helper: keys, windows, screens and audio. The same operations as scripts/input-host.ps1 (which stays as the
// fallback), using DeckNative.cs for everything that touches Windows.
static class InputOps {
    const string MMDevices = @"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio";

    static Dictionary<string, object> AudioState() {
        var state = HostLoop.Ok();
        state["level"] = (int)Math.Round(DeckNative.GetVolume(null) * 100);
        state["muted"] = DeckNative.GetMute(null);
        return state;
    }

    // "{0.0.0.00000000}.{guid}" is playback, "{0.0.1.…}" is capture; the friendly name lives in the registry
    static Dictionary<string, object> DeviceInfo(string id, string defaultId) {
        bool capture = id.StartsWith("{0.0.1.", StringComparison.Ordinal);
        string flow = capture ? "Capture" : "Render";
        int cut = id.IndexOf("}.", StringComparison.Ordinal);
        string guid = cut >= 0 ? id.Substring(cut + 2) : id;
        string name = null;
        string adapter = null;
        try {
            using (var key = Registry.LocalMachine.OpenSubKey(MMDevices + @"\" + flow + @"\" + guid + @"\Properties")) {
                if (key != null) {
                    name = key.GetValue("{a45c254e-df1c-4efd-8020-67d146a850e0},2") as string;
                    adapter = key.GetValue("{b3f8fa53-0004-438e-9003-51a46e139bfc},6") as string;
                }
            }
        } catch (Exception) { }

        var info = new Dictionary<string, object>();
        info["id"] = id;
        info["name"] = string.IsNullOrEmpty(name) ? id : name;
        info["adapter"] = adapter;
        info["flow"] = flow.ToLowerInvariant();
        info["default"] = id == defaultId;
        info["level"] = null;
        info["muted"] = null;
        try {
            info["level"] = (int)Math.Round(DeckNative.GetVolume(id) * 100);
            info["muted"] = DeckNative.GetMute(id);
        } catch (Exception) { }
        return info;
    }

    static string[] ProcessLabel(int pid) {
        try {
            using (var process = Process.GetProcessById(pid)) {
                string label = process.ProcessName;
                try {
                    string description = process.MainModule.FileVersionInfo.FileDescription;
                    if (!string.IsNullOrEmpty(description)) label = description;
                } catch (Exception) { }
                return new[] { process.ProcessName, label };
            }
        } catch (Exception) {
            return new[] { "pid" + pid, "PID " + pid };
        }
    }

    static Dictionary<int, string> ProcessNames() {
        var names = new Dictionary<int, string>();
        foreach (var process in Process.GetProcesses()) {
            try { names[process.Id] = process.ProcessName; } catch (Exception) { }
            process.Dispose();
        }
        return names;
    }

    // Window actions only apply to a handle that is in the list of windows right now: the phone can't make this
    // process touch an arbitrary window.
    static long KnownHandle(Dictionary<string, object> request) {
        long handle = Json.Long(request, "handle");
        foreach (var window in DeckNative.Windows()) if (window.Handle == handle) return handle;
        throw new Exception("window not found");
    }

    static object OrNull(double? value) { return value.HasValue ? (object)value.Value : null; }

    public static Dictionary<string, object> WindowsSnapshot() {
        var names = ProcessNames();
        var result = HostLoop.Ok();
        result["running"] = names.Values.Select(n => n.ToLowerInvariant()).Distinct().ToList();
        var list = new List<object>();
        foreach (var w in DeckNative.Windows()) {
            var entry = new Dictionary<string, object>();
            entry["handle"] = w.Handle;
            entry["pid"] = (int)w.Pid;
            entry["title"] = w.Title;
            entry["state"] = w.State;
            entry["monitor"] = w.Monitor;
            entry["x"] = w.X;
            entry["y"] = w.Y;
            entry["w"] = w.W;
            entry["h"] = w.H;
            string name;
            entry["name"] = names.TryGetValue((int)w.Pid, out name) ? name.ToLowerInvariant() : "";
            list.Add(entry);
        }
        result["windows"] = list;
        return result;
    }

    public static void Register(HostLoop host) {
        DeckNative.EnableDpiAwareness(); // window and monitor rectangles are then in real pixels on every screen

        host.On("ping", r => HostLoop.Ok());
        host.On("keys", r => { DeckNative.Combo(Json.Ints(r, "vks")); return null; });

        host.On("getVolume", r => AudioState());
        host.On("setVolume", r => {
            int level = Json.Int(r, "level");
            DeckNative.SetVolume(null, level / 100f);
            // like the Windows slider: raising the volume leaves mute
            if (level > 0 && DeckNative.GetMute(null)) DeckNative.SetMute(null, false);
            return AudioState();
        });
        host.On("setMute", r => { DeckNative.SetMute(null, Json.Bool(r, "muted")); return AudioState(); });
        host.On("toggleMute", r => { DeckNative.SetMute(null, !DeckNative.GetMute(null)); return AudioState(); });

        // the default recording device, for the header's mic button
        host.On("getMic", r => {
            var result = HostLoop.Ok();
            try {
                result["muted"] = DeckNative.GetMute(DeckNative.DefaultId(1));
                result["available"] = true;
            } catch (Exception) {
                result["muted"] = false;
                result["available"] = false;
            }
            return result;
        });
        host.On("setMic", r => {
            string mic = DeckNative.DefaultId(1);
            bool muted = Json.Bool(r, "toggle") ? !DeckNative.GetMute(mic) : Json.Bool(r, "muted");
            DeckNative.SetMute(mic, muted);
            var result = HostLoop.Ok();
            result["muted"] = muted;
            result["available"] = true;
            return result;
        });

        host.On("devices", r => {
            string renderDefault = DeckNative.DefaultId(0);
            string captureDefault = null;
            try { captureDefault = DeckNative.DefaultId(1); } catch (Exception) { }
            var result = HostLoop.Ok();
            result["playback"] = DeckNative.ActiveIds(0).Select(id => (object)DeviceInfo(id, renderDefault)).ToList();
            result["capture"] = DeckNative.ActiveIds(1).Select(id => (object)DeviceInfo(id, captureDefault)).ToList();
            return result;
        });
        host.On("setDefaultDevice", r => { DeckNative.SetDefault(Json.Str(r, "deviceId")); return null; });
        host.On("setDeviceVolume", r => {
            string id = Json.Str(r, "deviceId");
            int level = Json.Int(r, "level");
            DeckNative.SetVolume(id, level / 100f);
            if (level > 0 && DeckNative.GetMute(id)) DeckNative.SetMute(id, false);
            return null;
        });
        host.On("setDeviceMute", r => { DeckNative.SetMute(Json.Str(r, "deviceId"), Json.Bool(r, "muted")); return null; });

        host.On("sessions", r => {
            // one entry per process: browsers and games open several audio sessions
            var byPid = new Dictionary<string, Dictionary<string, object>>();
            var order = new List<string>();
            foreach (var s in DeckNative.Sessions()) {
                if (s.State == 2) continue; // expired
                string key = s.System ? "system" : s.Pid.ToString(CultureInfo.InvariantCulture);
                if (!byPid.ContainsKey(key)) {
                    string[] label = s.System ? new[] { "system", "Sons do sistema" } : ProcessLabel((int)s.Pid);
                    var entry = new Dictionary<string, object>();
                    entry["pid"] = (int)s.Pid;
                    entry["system"] = s.System;
                    entry["name"] = label[0];
                    entry["label"] = label[1];
                    entry["level"] = (int)Math.Round(s.Volume * 100);
                    entry["muted"] = s.Muted;
                    entry["active"] = false;
                    byPid[key] = entry;
                    order.Add(key);
                }
                if (s.State == 1) byPid[key]["active"] = true;
            }
            var sorted = order.Select(k => byPid[k])
                .OrderBy(e => (bool)e["active"] ? 0 : 1)
                .ThenBy(e => (string)e["label"], StringComparer.CurrentCultureIgnoreCase)
                .Cast<object>().ToList();
            var result = HostLoop.Ok();
            result["sessions"] = sorted;
            return result;
        });
        host.On("setSessionVolume", r => { DeckNative.SetSessionVolume((uint)Json.Long(r, "pid"), Json.Bool(r, "system"), (float)(Json.Num(r, "level") / 100)); return null; });
        host.On("setSessionMute", r => { DeckNative.SetSessionMute((uint)Json.Long(r, "pid"), Json.Bool(r, "system"), Json.Bool(r, "muted")); return null; });

        // while someone watches, changes to the windows arrive as {"event":"windows"} lines (see WindowEvents.cs)
        host.On("watchWindows", r => { WindowEvents.Watch(Json.Bool(r, "on")); return null; });
        host.On("windows", r => WindowsSnapshot());
        host.On("windowAction", r => {
            long handle = KnownHandle(r);
            string action = Json.Str(r, "action");
            if (action == "focus") DeckNative.Focus(handle); else DeckNative.WindowAction(handle, action);
            return null;
        });
        host.On("moveWindow", r => { DeckNative.MoveToMonitor(KnownHandle(r), Json.Int(r, "monitor")); return null; });
        host.On("placeWindow", r => { DeckNative.PlaceWindow(KnownHandle(r), Json.Int(r, "x"), Json.Int(r, "y")); return null; });
        host.On("snapWindow", r => { DeckNative.SnapWindow(KnownHandle(r), Json.Int(r, "monitor"), Json.Str(r, "zone")); return null; });

        host.On("monitors", r => {
            var list = new List<object>();
            foreach (var m in DeckNative.Monitors(Json.Bool(r, "brightness"))) {
                var entry = new Dictionary<string, object>();
                entry["device"] = m.Device;
                entry["left"] = m.Left;
                entry["top"] = m.Top;
                entry["width"] = m.Width;
                entry["height"] = m.Height;
                entry["primary"] = m.Primary;
                entry["brightness"] = m.Brightness >= 0 ? (object)m.Brightness : null;
                list.Add(entry);
            }
            var result = HostLoop.Ok();
            result["monitors"] = list;
            return result;
        });
        host.On("setBrightness", r => { DeckNative.SetBrightness(Json.Str(r, "device"), Json.Int(r, "level")); return null; });
        host.On("screensOff", r => { DeckNative.ScreensOff(); return null; });

        host.On("focus", r => {
            string target = (Json.Str(r, "name") ?? "").ToLowerInvariant();
            var pids = new HashSet<uint>();
            foreach (var p in Process.GetProcesses()) {
                try { if (p.ProcessName.ToLowerInvariant() == target) pids.Add((uint)p.Id); } catch (Exception) { }
                p.Dispose();
            }
            var result = HostLoop.Ok();
            WindowInfo window = DeckNative.Windows().FirstOrDefault(w => pids.Contains(w.Pid));
            if (window != null) { DeckNative.Focus(window.Handle); result["focused"] = true; } else { result["focused"] = false; }
            return result;
        });
    }
}

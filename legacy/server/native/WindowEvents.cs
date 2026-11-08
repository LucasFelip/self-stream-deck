using System;
using System.Runtime.InteropServices;
using System.Threading;

// Tells the server when the set of windows changes (opened, closed, moved, resized, minimized, brought to the front, renamed)
// instead of the server asking every 600 ms. It uses Windows' own notifications (SetWinEventHook), which need a message loop,
// so they live on a thread of their own that exists only while somebody watches: {"op":"watchWindows","on":true}.
// Every change becomes one {"event":"windows"} line, after a short pause so a burst (a window being dragged) is one event.
static class WindowEvents {
    delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    const uint WINEVENT_OUTOFCONTEXT = 0, WINEVENT_SKIPOWNPROCESS = 2, WM_QUIT = 0x0012;
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    const uint EVENT_OBJECT_CREATE = 0x8000, EVENT_OBJECT_NAMECHANGE = 0x800C, EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    const int OBJID_WINDOW = 0;

    static readonly object Gate = new object();
    static Thread pump;
    static uint pumpId;
    static WinEventProc callback; // kept in a field: the hooks must never lose their delegate to the garbage collector
    static Timer quick, slow;

    public static void Watch(bool on) {
        lock (Gate) {
            if (on && pump == null) {
                var ready = new ManualResetEvent(false);
                pump = new Thread(() => Loop(ready));
                pump.IsBackground = true;
                pump.Start();
                ready.WaitOne(2000);
            } else if (!on && pump != null) {
                PostThreadMessage(pumpId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                pump = null;
            }
        }
    }

    static void Loop(ManualResetEvent ready) {
        pumpId = GetCurrentThreadId();
        callback = OnEvent;
        // two ranges cover everything of interest: system events (foreground, minimize, move/size) and object events (create ... name change)
        IntPtr first = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        IntPtr second = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        ready.Set();
        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
        if (first != IntPtr.Zero) UnhookWinEvent(first);
        if (second != IntPtr.Zero) UnhookWinEvent(second);
    }

    static void OnEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
        // only whole windows (not their scroll bars, carets or menus)
        if (idObject != OBJID_WINDOW || idChild != 0 || hwnd == IntPtr.Zero) return;
        // a title that keeps changing (a terminal's spinner) is announced at most about twice a second; everything else after 40 ms
        if (eventType == EVENT_OBJECT_NAMECHANGE) Arm(ref slow, 600);
        else Arm(ref quick, 40);
    }

    static void Arm(ref Timer timer, int ms) {
        lock (Gate) {
            if (timer != null) return; // already waiting: the event that fires covers this one too
            timer = new Timer(Fire, null, ms, Timeout.Infinite);
        }
    }

    static void Fire(object state) {
        lock (Gate) {
            if (quick != null) { quick.Dispose(); quick = null; }
            if (slow != null) { slow.Dispose(); slow = null; }
        }
        HostLoop.Event("windows");
    }
}

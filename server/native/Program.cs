using System;
using System.Threading;

// ssd-helper.exe <mode>: the Windows-side helper of the deck server, one process per mode (input, media, monitor).
// It replaces the PowerShell helpers in scripts/ with the same line protocol: far less memory, and it starts in a few ms.
static class Program {
    [STAThread]
    static int Main(string[] args) {
        string mode = args.Length > 0 ? args[0] : "";
        var host = new HostLoop();
        switch (mode) {
            case "input":
                InputOps.Register(host);
                break;
            case "media":
                MediaOps.Register(host);
                break;
            case "monitor":
                MonitorOps.Register(host);
                break;
            case "vcam":
                return VcamMode.Run();
            default:
                Console.Error.WriteLine("usage: ssd-helper <input|media|monitor>");
                return 2;
        }
        host.Run();
        return 0;
    }
}


using System;
using System.IO;

// "vcam" mode: reads length-prefixed JPEG frames from stdin (4-byte little-endian length, 0 = quit) and publishes them to the
// "Stream Deck Camera" device. Same protocol as scripts/vcam-host.ps1; writes {"ready":bool,"sent":n} about once a second.
static class VcamMode {
    static bool ReadExact(Stream stream, byte[] buffer, int count) {
        int got = 0;
        while (got < count) {
            int n = stream.Read(buffer, got, count - got);
            if (n <= 0) return false;
            got += n;
        }
        return true;
    }

    public static int Run() {
        var stdin = Console.OpenStandardInput();
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false));
        var header = new byte[4];
        DateTime lastReport = DateTime.UtcNow;
        while (true) {
            if (!ReadExact(stdin, header, 4)) break;
            int length = BitConverter.ToInt32(header, 0);
            if (length <= 0 || length > 4 * 1024 * 1024) break; // never trust a length that large: something is wrong, stop
            var frame = new byte[length];
            if (!ReadExact(stdin, frame, length)) break;

            bool ok = false;
            try { ok = VCam.Send(frame); } catch (Exception) { }

            if ((DateTime.UtcNow - lastReport).TotalMilliseconds >= 1000) {
                lastReport = DateTime.UtcNow;
                stdout.WriteLine("{\"ready\":" + (ok ? "true" : "false") + ",\"sent\":" + VCam.Sent + "}");
                stdout.Flush();
            }
        }
        return 0;
    }
}

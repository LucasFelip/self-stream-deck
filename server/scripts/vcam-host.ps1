# Direct virtual camera feeder.
#
# Reads frames from stdin (a 4-byte little-endian length, then that many bytes of JPEG; length 0 = quit), decodes them
# and hands them to the "Stream Deck Camera" DirectShow device, which is the UnityCapture filter. The filter and this
# script talk through the shared memory the filter publishes while some app (Discord, Zoom, a browser...) has the camera
# open; with nobody watching there is nothing to write to and frames are simply dropped.
#
# Protocol (UnityCapture, Source/shared.inl): named mutex "UnityCapture_Mutx", events "UnityCapture_Want" and
# "UnityCapture_Sent" and the mapping "UnityCapture_Data", whose header is
#   DWORD maxSize; int width, height, stride(pixels), format(0 = RGBA 8 bit), resizemode, mirrormode, timeout(ms); pixels...
# Writes one JSON line to stdout about once a second: {"ready":bool,"sent":n}.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class VCam {
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr OpenMutexA(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr CreateEventA(IntPtr attrs, bool manual, bool initial, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr OpenEventA(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr OpenFileMappingA(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr MapViewOfFile(IntPtr map, uint access, uint high, uint low, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool ReleaseMutex(IntPtr mutex);
    [DllImport("kernel32.dll")] static extern bool SetEvent(IntPtr handle);

    const uint SYNCHRONIZE = 0x00100000, EVENT_MODIFY_STATE = 0x0002, FILE_MAP_WRITE = 0x0002;
    static IntPtr mutex, want, sent, file, view;
    public static long Sent;

    // Mirrors the order of the filter's own Open(): each step may have to wait for the filter's side to appear.
    public static bool Ready() {
        if (view != IntPtr.Zero) return true;
        if (mutex == IntPtr.Zero) { mutex = OpenMutexA(SYNCHRONIZE, false, "UnityCapture_Mutx"); if (mutex == IntPtr.Zero) return false; }
        if (WaitForSingleObject(mutex, 200) != 0) return false;
        try {
            if (want == IntPtr.Zero) { want = CreateEventA(IntPtr.Zero, false, false, "UnityCapture_Want"); if (want == IntPtr.Zero) return false; }
            if (sent == IntPtr.Zero) { sent = OpenEventA(EVENT_MODIFY_STATE, false, "UnityCapture_Sent"); if (sent == IntPtr.Zero) return false; }
            if (file == IntPtr.Zero) { file = OpenFileMappingA(FILE_MAP_WRITE, false, "UnityCapture_Data"); if (file == IntPtr.Zero) return false; }
            view = MapViewOfFile(file, FILE_MAP_WRITE, 0, 0, UIntPtr.Zero);
            return view != IntPtr.Zero;
        } finally { ReleaseMutex(mutex); }
    }

    // Decodes a JPEG and publishes it. Returns false when nobody is receiving (or the frame does not fit).
    public static bool Send(byte[] jpeg) {
        if (!Ready()) return false;
        using (var stream = new MemoryStream(jpeg))
        using (var image = new Bitmap(stream)) {
            int width = image.Width, height = image.Height;
            var area = new Rectangle(0, 0, width, height);
            BitmapData data = image.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                int bytes = width * height * 4;
                if ((uint)bytes > (uint)Marshal.ReadInt32(view, 0)) return false;
                var pixels = new byte[bytes];
                // rows go in bottom-up: the filter takes Unity's orientation (origin at the bottom), so a top-down picture would
                // reach the apps upside down
                for (int y = 0; y < height; y++) Marshal.Copy(IntPtr.Add(data.Scan0, (height - 1 - y) * data.Stride), pixels, y * width * 4, width * 4);
                for (int i = 0; i < bytes; i += 4) { byte b = pixels[i]; pixels[i] = pixels[i + 2]; pixels[i + 2] = b; pixels[i + 3] = 255; } // BGRA -> RGBA

                if (WaitForSingleObject(mutex, 500) != 0) return false;
                try {
                    Marshal.WriteInt32(view, 4, width);
                    Marshal.WriteInt32(view, 8, height);
                    Marshal.WriteInt32(view, 12, width);   // stride, in pixels
                    Marshal.WriteInt32(view, 16, 0);       // FORMAT_UINT8
                    Marshal.WriteInt32(view, 20, 1);       // resize to whatever size the app asks for
                    Marshal.WriteInt32(view, 24, 0);       // no mirroring: the page already sends the unmirrored picture
                    Marshal.WriteInt32(view, 28, 1000);    // ms before the filter calls the source stopped
                    Marshal.Copy(pixels, 0, IntPtr.Add(view, 32), bytes);
                } finally { ReleaseMutex(mutex); }
                SetEvent(sent);
                Sent++;
                return true;
            } finally { image.UnlockBits(data); }
        }
    }
}
'@ -ReferencedAssemblies System.Drawing

$stdin = [Console]::OpenStandardInput()
$header = New-Object byte[] 4
$lastReport = [DateTime]::UtcNow

function Read-Exact([byte[]]$buffer, [int]$count) {
    $got = 0
    while ($got -lt $count) {
        $n = $stdin.Read($buffer, $got, $count - $got)
        if ($n -le 0) { return $false }
        $got += $n
    }
    return $true
}

while ($true) {
    if (-not (Read-Exact $header 4)) { break }
    $length = [BitConverter]::ToInt32($header, 0)
    if ($length -le 0) { break }
    if ($length -gt 4MB) { break } # never trust a length that large: something is wrong, stop
    $frame = New-Object byte[] $length
    if (-not (Read-Exact $frame $length)) { break }

    $ok = $false
    try { $ok = [VCam]::Send($frame) } catch { }

    if (([DateTime]::UtcNow - $lastReport).TotalMilliseconds -ge 1000) {
        $lastReport = [DateTime]::UtcNow
        [Console]::Out.WriteLine(('{{"ready":{0},"sent":{1}}}' -f $ok.ToString().ToLower(), [VCam]::Sent))
        [Console]::Out.Flush()
    }
}

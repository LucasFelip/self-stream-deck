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

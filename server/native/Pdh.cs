using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// Windows performance counters through the PDH API. One query holds every counter (wildcard instances included), so one
// collection reads them all at once: much cheaper than a PerformanceCounter object per core/disk/adapter, whose creation
// alone took seconds. A background thread collects every second; readers get the latest formatted values.
sealed class Pdh {
    [StructLayout(LayoutKind.Explicit)]
    struct FmtValue {
        [FieldOffset(0)] public uint Status;
        [FieldOffset(8)] public double Double;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FmtItem {
        public IntPtr Name;
        public FmtValue Value;
    }

    const uint FORMAT_DOUBLE = 0x00000200;
    const uint MORE_DATA = 0x800007D2;

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhOpenQuery(string source, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")]
    static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")]
    static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, IntPtr type, out FmtValue value);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);

    readonly IntPtr query;
    readonly object gate = new object();
    readonly Dictionary<string, IntPtr> counters = new Dictionary<string, IntPtr>();
    readonly Dictionary<string, Dictionary<string, double>> arrays = new Dictionary<string, Dictionary<string, double>>();
    readonly Dictionary<string, double> singles = new Dictionary<string, double>();
    int collections;

    public Pdh() {
        if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) throw new Exception("PDH is not available");
    }

    /// <summary>Adds a counter path such as \Processor Information(*)\% Processor Utility. False when this Windows has no such counter.</summary>
    public bool Add(string key, string path) {
        IntPtr counter;
        if (PdhAddEnglishCounter(query, path, IntPtr.Zero, out counter) != 0) return false;
        counters[key] = counter;
        return true;
    }

    /// <summary>Starts collecting once a second (the first collection is made right away, so rates have a baseline).</summary>
    public void Start() {
        PdhCollectQueryData(query);
        collections = 1; // the baseline for the rates
        var thread = new Thread(() => {
            while (true) {
                Thread.Sleep(1000);
                Collect();
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    void Collect() {
        try {
            if (PdhCollectQueryData(query) != 0) return;
            var newArrays = new Dictionary<string, Dictionary<string, double>>();
            var newSingles = new Dictionary<string, double>();
            foreach (var pair in counters) {
                var values = Format(pair.Value);
                if (values != null) newArrays[pair.Key] = values;
                FmtValue single;
                if (PdhGetFormattedCounterValue(pair.Value, FORMAT_DOUBLE, IntPtr.Zero, out single) == 0 && (single.Status == 0 || single.Status == 1)) newSingles[pair.Key] = single.Double;
            }
            lock (gate) {
                foreach (var pair in newArrays) arrays[pair.Key] = pair.Value;
                foreach (var pair in newSingles) singles[pair.Key] = pair.Value;
                collections += 1;
            }
        } catch (Exception) { }
    }

    // wildcard counters: one value per instance
    static Dictionary<string, double> Format(IntPtr counter) {
        uint size = 0, count = 0;
        uint status = PdhGetFormattedCounterArray(counter, FORMAT_DOUBLE, ref size, out count, IntPtr.Zero);
        if (status != MORE_DATA || size == 0) return null;
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try {
            if (PdhGetFormattedCounterArray(counter, FORMAT_DOUBLE, ref size, out count, buffer) != 0) return null;
            var result = new Dictionary<string, double>();
            int stride = Marshal.SizeOf(typeof(FmtItem));
            for (int i = 0; i < count; i++) {
                var item = (FmtItem)Marshal.PtrToStructure(IntPtr.Add(buffer, i * stride), typeof(FmtItem));
                if (item.Value.Status != 0 && item.Value.Status != 1) continue;
                string name = Marshal.PtrToStringUni(item.Name);
                if (name != null) result[name] = item.Value.Double;
            }
            return result;
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    /// <summary>Waits until two collections exist (rates need two), up to the timeout.</summary>
    public void WaitForRates(int timeoutMs) {
        DateTime until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < until) {
            lock (gate) { if (collections >= 2) return; }
            Thread.Sleep(50);
        }
    }

    public Dictionary<string, double> Instances(string key) {
        lock (gate) {
            Dictionary<string, double> values;
            return arrays.TryGetValue(key, out values) ? values : new Dictionary<string, double>();
        }
    }

    public double? Value(string key) {
        lock (gate) {
            double value;
            return singles.TryGetValue(key, out value) ? (double?)value : null;
        }
    }
}

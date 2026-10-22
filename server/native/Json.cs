using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

// Minimal JSON for the helper protocol (one object per line). Requests arrive as Dictionary<string, object>; numbers may be
// int, long, decimal or double depending on size, so the readers below accept any of them.
static class Json {
    static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 20 };

    public static Dictionary<string, object> Parse(string line) {
        return (Dictionary<string, object>)Serializer.DeserializeObject(line);
    }

    public static string Write(object value) { return Serializer.Serialize(value); }

    static object Get(Dictionary<string, object> map, string key) {
        object value;
        return map.TryGetValue(key, out value) ? value : null;
    }

    public static string Str(Dictionary<string, object> map, string key) {
        object value = Get(map, key);
        return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    public static double Num(Dictionary<string, object> map, string key) {
        object value = Get(map, key);
        if (value == null) throw new ArgumentException("missing number '" + key + "'");
        return Convert.ToDouble(value, CultureInfo.InvariantCulture);
    }

    public static int Int(Dictionary<string, object> map, string key) { return (int)Math.Round(Num(map, key)); }

    public static long Long(Dictionary<string, object> map, string key) { return (long)Math.Round(Num(map, key)); }

    public static bool Bool(Dictionary<string, object> map, string key) {
        object value = Get(map, key);
        if (value == null) return false;
        if (value is bool) return (bool)value;
        double number;
        return double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out number) && number != 0;
    }

    public static int[] Ints(Dictionary<string, object> map, string key) {
        object value = Get(map, key);
        var list = value as IEnumerable;
        if (list == null) throw new ArgumentException("missing list '" + key + "'");
        var result = new List<int>();
        foreach (object item in list) result.Add((int)Math.Round(Convert.ToDouble(item, CultureInfo.InvariantCulture)));
        return result.ToArray();
    }
}

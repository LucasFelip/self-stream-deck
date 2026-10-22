using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;

// The line protocol every helper speaks (same as the PowerShell helpers): one JSON request per line on stdin
// ({"id":1,"op":"..."}), one JSON answer per line on stdout ({"id":1,"ok":true,...} or {"id":1,"ok":false,"error":"..."}).
// A line without "id" is an event the helper volunteers, e.g. {"event":"windows"}.
delegate Dictionary<string, object> Handler(Dictionary<string, object> request);

class HostLoop {
    static readonly object OutLock = new object();
    static StreamWriter output;

    readonly Dictionary<string, Handler> ops = new Dictionary<string, Handler>();

    public void On(string op, Handler handler) { ops[op] = handler; }

    public static Dictionary<string, object> Ok() { return new Dictionary<string, object>(); }

    /// <summary>One answer or event line, written whole (several threads may write).</summary>
    public static void Emit(Dictionary<string, object> message) {
        lock (OutLock) {
            output.WriteLine(Json.Write(message));
            output.Flush();
        }
    }

    public static void Event(string name) {
        var message = new Dictionary<string, object>();
        message["event"] = name;
        Emit(message);
    }

    public void Run() {
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        var ready = new Dictionary<string, object>();
        ready["id"] = 0;
        ready["ok"] = true;
        ready["ready"] = true;
        Emit(ready);

        string line;
        while ((line = input.ReadLine()) != null) {
            if (line.Trim().Length == 0) continue;
            object id = null;
            Dictionary<string, object> response;
            try {
                var request = Json.Parse(line);
                request.TryGetValue("id", out id);
                string op = Json.Str(request, "op");
                Handler handler;
                if (op == null || !ops.TryGetValue(op, out handler)) throw new Exception("unknown op '" + op + "'");
                response = handler(request) ?? Ok();
                response["id"] = id;
                response["ok"] = true;
            } catch (Exception error) {
                while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
                response = new Dictionary<string, object>();
                response["id"] = id;
                response["ok"] = false;
                response["error"] = error.Message;
            }
            Emit(response);
        }
    }
}

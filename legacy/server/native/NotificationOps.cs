using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

// "notifications" helper: the Windows notification listener (the same list as the Action Center, which also receives what Do Not
// Disturb or a game kept from popping up). Same operations as scripts/notifications-host.ps1. Reached by name at run time through
// `dynamic`, like MediaOps (the C# 5 compiler that ships with Windows cannot reference the Windows metadata).
static class NotificationOps {
    static MethodInfo asTask;
    static Type accessType, listType;
    static object toastKind;
    static dynamic listener;
    static MethodInfo getNotifications;

    static Type WinRT(string name) {
        Type type = Type.GetType(name + ", Windows.UI.Notifications, ContentType=WindowsRuntime");
        if (type == null) throw new Exception("Windows notification API not available: " + name);
        return type;
    }

    static void Init() {
        if (listener != null) return;
        string runtime = "System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";
        Type extensions = Type.GetType("System.WindowsRuntimeSystemExtensions, " + runtime);
        asTask = extensions.GetMethods().First(m => m.Name == "AsTask" && m.GetParameters().Length == 1
            && m.GetParameters()[0].ParameterType.Name == "IAsyncOperation`1");

        Type listenerType = WinRT("Windows.UI.Notifications.Management.UserNotificationListener");
        accessType = WinRT("Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus");
        Type notification = WinRT("Windows.UI.Notifications.UserNotification");
        listType = typeof(IReadOnlyList<>).MakeGenericType(notification);
        toastKind = Enum.ToObject(WinRT("Windows.UI.Notifications.NotificationKinds"), 1); // Toast
        getNotifications = listenerType.GetMethod("GetNotificationsAsync");
        listener = listenerType.GetProperty("Current").GetValue(null, null);
    }

    // WinRT async operations -> synchronous results
    static object Await(object operation, Type resultType) {
        var task = (Task)asTask.MakeGenericMethod(resultType).Invoke(null, new[] { operation });
        if (!task.Wait(8000)) throw new Exception("notification operation timed out");
        return task.GetType().GetProperty("Result").GetValue(task, null);
    }

    // plain reflection with the lookups cached: `dynamic` over WinRT objects costs tens of milliseconds a property, and this is asked every 2 s
    static readonly Dictionary<string, PropertyInfo> props = new Dictionary<string, PropertyInfo>();
    static readonly Dictionary<string, MethodInfo> methods = new Dictionary<string, MethodInfo>();

    static object Get(object target, string name) {
        if (target == null) return null;
        Type type = target.GetType();
        string key = type.FullName + "." + name;
        PropertyInfo property;
        if (!props.TryGetValue(key, out property)) {
            property = type.GetProperty(name);
            props[key] = property;
        }
        return property == null ? null : property.GetValue(target, null);
    }

    static object Call(object target, string name) {
        Type type = target.GetType();
        string key = type.FullName + "." + name;
        MethodInfo method;
        if (!methods.TryGetValue(key, out method)) {
            method = type.GetMethod(name, Type.EmptyTypes);
            methods[key] = method;
        }
        return method == null ? null : method.Invoke(target, null);
    }

    static Dictionary<string, object> Describe(object item) {
        var texts = new List<string>();
        try {
            foreach (object binding in (System.Collections.IEnumerable)Get(Get(Get(item, "Notification"), "Visual"), "Bindings")) {
                foreach (object element in (System.Collections.IEnumerable)Call(binding, "GetTextElements")) {
                    string text = (string)Get(element, "Text");
                    if (!string.IsNullOrEmpty(text)) texts.Add(text);
                }
            }
        } catch (Exception) { }
        string name = null;
        try { name = (string)Get(Get(Get(item, "AppInfo"), "DisplayInfo"), "DisplayName"); } catch (Exception) { }
        var result = new Dictionary<string, object>();
        result["id"] = (long)(uint)Get(item, "Id");
        result["aumid"] = (string)Get(Get(item, "AppInfo"), "AppUserModelId");
        result["app"] = name;
        result["title"] = texts.Count > 0 ? texts[0] : "";
        result["body"] = string.Join("\n", texts.Skip(1).ToArray());
        result["time"] = ((DateTimeOffset)Get(item, "CreationTime")).ToUnixTimeMilliseconds();
        return result;
    }

    public static void Register(HostLoop host) {
        host.On("ping", r => HostLoop.Ok());

        host.On("list", r => {
            Init();
            object access = listener.GetAccessStatus();
            if (access.ToString() != "Allowed") access = Await(listener.RequestAccessAsync(), accessType);
            var result = HostLoop.Ok();
            result["access"] = access.ToString().ToLowerInvariant();
            var notifications = new List<object>();
            if (access.ToString() == "Allowed") {
                object items = Await(getNotifications.Invoke((object)listener, new object[] { toastKind }), listType);
                var sorted = new List<object>();
                foreach (object item in (System.Collections.IEnumerable)items) sorted.Add(item);
                foreach (object item in sorted.OrderBy(i => (DateTimeOffset)Get(i, "CreationTime"))) notifications.Add(Describe(item));
            }
            result["notifications"] = notifications;
            return result;
        });
    }
}

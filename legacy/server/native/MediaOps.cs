using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

// "media" helper: the Windows System Media Transport Controls (what the volume flyout shows): Spotify, a YouTube tab,
// VLC... Same operations as scripts/media-host.ps1. The WinRT types are reached by name at run time (the C# 5 compiler
// that ships with Windows cannot reference the Windows metadata), through `dynamic`.
static class MediaOps {
    static MethodInfo asTask;
    static MethodInfo asStreamForRead;
    static Type managerType, propsType, streamType;
    static PropertyInfo contentType;
    static dynamic manager;
    static readonly SHA1 Sha = SHA1.Create();

    static Type WinRT(string name, string assembly) {
        Type type = Type.GetType(name + ", " + assembly + ", ContentType=WindowsRuntime");
        if (type == null) throw new Exception("Windows media API not available: " + name);
        return type;
    }

    static void Init() {
        if (manager != null) return;
        string runtime = "System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";
        Type extensions = Type.GetType("System.WindowsRuntimeSystemExtensions, " + runtime);
        asTask = extensions.GetMethods().First(m => m.Name == "AsTask" && m.GetParameters().Length == 1
            && m.GetParameters()[0].ParameterType.Name == "IAsyncOperation`1");

        managerType = WinRT("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager", "Windows.Media.Control");
        propsType = WinRT("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties", "Windows.Media.Control");
        streamType = WinRT("Windows.Storage.Streams.IRandomAccessStreamWithContentType", "Windows.Storage.Streams");
        Type inputStream = WinRT("Windows.Storage.Streams.IInputStream", "Windows.Storage.Streams");
        contentType = WinRT("Windows.Storage.Streams.IContentTypeProvider", "Windows.Storage.Streams").GetProperty("ContentType");
        asStreamForRead = Type.GetType("System.IO.WindowsRuntimeStreamExtensions, " + runtime).GetMethod("AsStreamForRead", new[] { inputStream });

        object operation = managerType.GetMethod("RequestAsync").Invoke(null, null);
        manager = Await(operation, managerType);
    }

    // WinRT async operations -> synchronous results
    static object Await(object operation, Type resultType) {
        var task = (Task)asTask.MakeGenericMethod(resultType).Invoke(null, new[] { operation });
        if (!task.Wait(8000)) throw new Exception("media operation timed out");
        return task.GetType().GetProperty("Result").GetValue(task, null);
    }

    static dynamic FindSession(string id) {
        foreach (dynamic session in manager.GetSessions()) {
            if ((string)session.SourceAppUserModelId == id) return session;
        }
        throw new Exception("media session not found");
    }

    static Dictionary<string, object> SessionInfo(dynamic session) {
        dynamic props = Await(session.TryGetMediaPropertiesAsync(), propsType);
        dynamic playback = session.GetPlaybackInfo();
        dynamic timeline = session.GetTimelineProperties();
        string status = ((object)playback.PlaybackStatus).ToString();

        TimeSpan start = timeline.StartTime;
        double duration = ((TimeSpan)timeline.EndTime).TotalSeconds - start.TotalSeconds;
        double position = ((TimeSpan)timeline.Position).TotalSeconds - start.TotalSeconds;
        object durationValue = null;
        object positionValue = null;
        if (duration > 0) {
            // the timeline is a snapshot taken at LastUpdatedTime; move it forward while playing
            if (status == "Playing") {
                double elapsed = (DateTimeOffset.UtcNow - (DateTimeOffset)timeline.LastUpdatedTime).TotalSeconds;
                if (elapsed > 0) position += elapsed;
            }
            durationValue = duration;
            positionValue = Math.Max(0, Math.Min(duration, position));
        }

        string id = (string)session.SourceAppUserModelId;
        string title = (string)props.Title;
        string artist = (string)props.Artist;
        string album = (string)props.AlbumTitle;
        byte[] hash = Sha.ComputeHash(Encoding.UTF8.GetBytes(id + "|" + title + "|" + artist + "|" + album));
        var controls = playback.Controls;

        var info = new Dictionary<string, object>();
        info["id"] = id;
        info["title"] = title;
        info["artist"] = artist;
        info["album"] = album;
        info["status"] = status.ToLowerInvariant();
        info["position"] = positionValue;
        info["duration"] = durationValue;
        info["canPlay"] = (bool)controls.IsPlayEnabled;
        info["canPause"] = (bool)controls.IsPauseEnabled;
        info["canNext"] = (bool)controls.IsNextEnabled;
        info["canPrev"] = (bool)controls.IsPreviousEnabled;
        info["canSeek"] = (bool)controls.IsPlaybackPositionEnabled;
        info["hasArt"] = props.Thumbnail != null;
        info["artKey"] = BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant().Substring(0, 12);
        return info;
    }

    public static void Register(HostLoop host) {
        host.On("ping", r => HostLoop.Ok());

        host.On("state", r => {
            Init();
            dynamic current = manager.GetCurrentSession();
            var result = HostLoop.Ok();
            result["current"] = current == null ? null : (string)current.SourceAppUserModelId;
            var sessions = new List<object>();
            foreach (dynamic session in manager.GetSessions()) sessions.Add(SessionInfo(session));
            result["sessions"] = sessions;
            return result;
        });

        host.On("control", r => {
            Init();
            dynamic session = FindSession(Json.Str(r, "session"));
            string action = Json.Str(r, "action");
            object operation;
            switch (action) {
                case "toggle": operation = session.TryTogglePlayPauseAsync(); break;
                case "play": operation = session.TryPlayAsync(); break;
                case "pause": operation = session.TryPauseAsync(); break;
                case "next": operation = session.TrySkipNextAsync(); break;
                case "previous": operation = session.TrySkipPreviousAsync(); break;
                case "seek": {
                    long start = ((TimeSpan)session.GetTimelineProperties().StartTime).Ticks;
                    operation = session.TryChangePlaybackPositionAsync((long)(start + Json.Num(r, "position") * 1e7));
                    break;
                }
                default: throw new Exception("unknown action '" + action + "'");
            }
            var result = HostLoop.Ok();
            result["accepted"] = (bool)Await(operation, typeof(bool));
            return result;
        });

        host.On("art", r => {
            Init();
            dynamic session = FindSession(Json.Str(r, "session"));
            dynamic props = Await(session.TryGetMediaPropertiesAsync(), propsType);
            var result = HostLoop.Ok();
            result["data"] = null;
            if (props.Thumbnail != null) {
                object stream = Await(props.Thumbnail.OpenReadAsync(), streamType);
                using (var reader = (Stream)asStreamForRead.Invoke(null, new object[] { stream })) {
                    var memory = new MemoryStream();
                    reader.CopyTo(memory);
                    result["mime"] = (string)contentType.GetValue(stream, null);
                    result["data"] = Convert.ToBase64String(memory.ToArray());
                }
            }
            return result;
        });
    }
}

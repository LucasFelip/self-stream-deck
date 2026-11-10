' Starts the Rust agent (ssd.exe) without a console window. Run by the "Self Stream Deck" scheduled task (see autostart.ps1 and install.ps1);
' can also be double-clicked. Output goes to the data folder's server.log (one previous generation is kept after 2 MB). It starts the agent again
' when the agent crashes (see the end of the script).
'
' usage: wscript launch-hidden.vbs "C:\path\to\ssd.exe" "C:\path\to\data" ["C:\path\to\web\dist"]
' Without the third argument the agent serves the interface packed inside its executable.

Option Explicit

Dim shell, fso, q, exe, dataDir, webDir, logFile, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

If WScript.Arguments.Count < 2 Then
  WScript.Echo "usage: launch-hidden.vbs ssd.exe data-dir [web-dist-dir]"
  WScript.Quit 2
End If
exe = WScript.Arguments(0)
dataDir = WScript.Arguments(1)
webDir = ""
If WScript.Arguments.Count > 2 Then webDir = WScript.Arguments(2)

If Not fso.FolderExists(dataDir) Then
  ' the parent exists for %APPDATA%\SelfStreamDeck; a deeper path is made one level at a time
  Dim parts, i, path
  parts = Split(dataDir, "\")
  path = parts(0)
  For i = 1 To UBound(parts)
    path = path & "\" & parts(i)
    If Not fso.FolderExists(path) Then fso.CreateFolder path
  Next
End If
logFile = dataDir & "\server.log"

If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 2097152 Then
    If fso.FileExists(logFile & ".old") Then fso.DeleteFile logFile & ".old"
    fso.MoveFile logFile, logFile & ".old"
  End If
End If

command = q & exe & q & " --data-dir " & q & dataDir & q
If webDir <> "" Then command = command & " --web-dir " & q & webDir & q

' The task that runs this script ends when this script ends, so the script stays and watches the agent: when it ends in any way but a
' clean exit (code 0: the tray's "Sair", a Ctrl+C) it is started again after 3 seconds, and what happened goes to the log. An agent that
' ends right away five times in a row is not started again (something is wrong that restarting does not fix: the log says what).
Dim code, startedAt, quick
quick = 0
Do
  startedAt = Now
  ' 0 = hidden window, True = wait for it to end (its exit code comes back)
  code = shell.Run("cmd /c " & q & command & " >> " & q & logFile & q & " 2>&1" & q, 0, True)
  If code = 0 Then Exit Do
  Log "[launcher] ssd.exe ended with code " & code & " (" & Hex(code) & "); starting it again"
  If DateDiff("s", startedAt, Now) < 20 Then quick = quick + 1 Else quick = 0
  If quick >= 5 Then
    Log "[launcher] ssd.exe ends right away every time; not starting it again"
    Exit Do
  End If
  WScript.Sleep 3000
Loop

Sub Log(message)
  Dim file
  Set file = fso.OpenTextFile(logFile, 8, True)
  file.WriteLine Now & " " & message
  file.Close
End Sub

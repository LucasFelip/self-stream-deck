' Starts the Rust agent (ssd.exe) without a console window. Run by the "Self Stream Deck" scheduled task (see autostart.ps1 and install.ps1);
' can also be double-clicked. Output goes to the data folder's server.log (one previous generation is kept after 2 MB).
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

' 0 = hidden window, False = don't wait
shell.Run "cmd /c " & q & command & " >> " & q & logFile & q & " 2>&1" & q, 0, False

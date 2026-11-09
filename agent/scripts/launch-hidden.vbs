' Starts the Rust agent (ssd.exe) without a console window. Run by the "Self Stream Deck" scheduled task (see autostart.ps1); can also be
' double-clicked. Output goes to the data folder's server.log (one previous generation is kept after 2 MB).
'
' usage: wscript launch-hidden.vbs "C:\path\to\ssd.exe" "C:\path\to\data" "C:\path\to\web\dist"

Option Explicit

Dim shell, fso, q, exe, dataDir, webDir, logFile

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

If WScript.Arguments.Count < 3 Then
  WScript.Echo "usage: launch-hidden.vbs ssd.exe data-dir web-dist-dir"
  WScript.Quit 2
End If
exe = WScript.Arguments(0)
dataDir = WScript.Arguments(1)
webDir = WScript.Arguments(2)

If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
logFile = dataDir & "\server.log"

If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 2097152 Then
    If fso.FileExists(logFile & ".old") Then fso.DeleteFile logFile & ".old"
    fso.MoveFile logFile, logFile & ".old"
  End If
End If

' 0 = hidden window, False = don't wait
shell.Run "cmd /c " & q & q & exe & q & " --data-dir " & q & dataDir & q & " --web-dir " & q & webDir & q & " >> " & q & logFile & q & " 2>&1" & q, 0, False

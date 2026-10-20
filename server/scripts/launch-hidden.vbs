' Starts the deck server without a console window. Run by the "Self Stream Deck" scheduled task
' (see autostart.ps1); can also be double-clicked. Output goes to data\server.log.
'
' usage: wscript launch-hidden.vbs ["C:\path\to\node.exe"]

Option Explicit

Dim shell, fso, q, scriptDir, serverDir, node, logFile

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverDir = fso.GetParentFolderName(scriptDir)

node = "node"
If WScript.Arguments.Count > 0 Then node = WScript.Arguments(0)

If Not fso.FolderExists(serverDir & "\data") Then fso.CreateFolder serverDir & "\data"
logFile = serverDir & "\data\server.log"

' keep the log from growing forever: one previous generation is enough
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 2097152 Then
    If fso.FileExists(logFile & ".old") Then fso.DeleteFile logFile & ".old"
    fso.MoveFile logFile, logFile & ".old"
  End If
End If

shell.CurrentDirectory = serverDir
' 0 = hidden window, False = don't wait
shell.Run "cmd /c " & q & q & node & q & " src\supervisor.js --phone >> " & q & logFile & q & " 2>&1" & q, 0, False

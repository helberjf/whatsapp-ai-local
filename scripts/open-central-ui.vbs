Option Explicit

Dim fso, shell, scriptDir, projectRoot, dataDir, logPath, command, argument, file
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
dataDir = fso.BuildPath(projectRoot, "data")
logPath = fso.BuildPath(dataDir, "launcher.log")

If Not fso.FolderExists(dataDir) Then fso.CreateFolder(dataDir)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & fso.BuildPath(scriptDir, "start-ui.ps1") & """"
For Each argument In WScript.Arguments
  If LCase(argument) = "-nobrowser" Then command = command & " -NoBrowser"
Next

On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
  Set file = fso.OpenTextFile(logPath, 8, True)
  file.WriteLine Now & " [vbs] " & Err.Description
  file.Close
  MsgBox "Não foi possível abrir o Whats AI. Consulte data\launcher.log.", 16, "Whats AI"
End If
On Error GoTo 0

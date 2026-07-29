Option Explicit

Dim shell, fileSystem, scriptDirectory, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = """" & scriptDirectory & "\veridia-open.cmd"""

exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "VERIDIA could not start. Check the project logs folder.", 16, "VERIDIA"
End If
WScript.Quit exitCode

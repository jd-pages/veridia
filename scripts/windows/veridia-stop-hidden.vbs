Option Explicit

Dim shell, fileSystem, scriptDirectory, command, exitCode, quiet
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = """" & scriptDirectory & "\veridia-stop.cmd"""
quiet = WScript.Arguments.Named.Exists("quiet")

exitCode = shell.Run(command, 0, True)
If Not quiet Then
  If exitCode = 0 Then
    MsgBox "The VERIDIA background service has stopped.", 64, "VERIDIA"
  Else
    MsgBox "VERIDIA could not stop. Check the project logs folder.", 16, "VERIDIA"
  End If
End If
WScript.Quit exitCode

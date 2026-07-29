Option Explicit

Dim shell, fileSystem, scriptDirectory, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = """" & scriptDirectory & "\veridia-autostart.cmd"""

shell.Run command, 0, False

Option Explicit

Dim shell, fileSystem, scriptDirectory, command, answer, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)

answer = MsgBox( _
  "Stop the VERIDIA background service?" & vbCrLf & vbCrLf & _
  "Yes: stop the service." & vbCrLf & _
  "No: keep it running in the background.", _
  35, _
  "Close VERIDIA" _
)

If answer = 6 Then
  command = """" & scriptDirectory & "\veridia-stop.cmd"""
  exitCode = shell.Run(command, 0, True)
  If exitCode = 0 Then
    MsgBox "The VERIDIA background service has stopped.", 64, "VERIDIA"
  Else
    MsgBox "VERIDIA could not stop. Check the project logs folder.", 16, "VERIDIA"
  End If
End If

' Pure ASCII: launch the bridge supervisor without a taskbar/console window.
Option Explicit

Dim shell, comspec, target, command
Set shell = CreateObject("WScript.Shell")
comspec = shell.ExpandEnvironmentStrings("%ComSpec%")
target = WScript.Arguments(0)
command = Chr(34) & comspec & Chr(34) & " /d /s /c " & Chr(34) & Chr(34) & target & Chr(34) & " __hidden" & Chr(34)
shell.Run command, 0, False

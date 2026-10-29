' run-hidden.vbs - launch a PowerShell script with NO visible window.
' Usage: wscript.exe //B "<repo>\tools\run-hidden.vbs" "<repo>\tools\<script>.ps1"
'
' Why: a scheduled task that runs powershell.exe directly (even with -WindowStyle Hidden)
' still flashes a console window for a moment, because the console is created before
' PowerShell processes the flag. wscript.exe is a GUI-subsystem host, so nothing flashes.
Option Explicit

Dim shell, scriptPath, cmd
If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

scriptPath = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"
' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False

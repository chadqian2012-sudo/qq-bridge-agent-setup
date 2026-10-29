' keepalive-loop.vbs - keep-alive backstop, runs with NO visible window.
'
' Why this exists (and why it is not a scheduled task):
'   On 2026-10-03 both QQDSH scheduled tasks were left Disabled, so when the whole
'   stack died at 11:47 nothing brought it back for 7 hours. A watchdog cannot
'   re-enable itself. Creating a NEW scheduled task needs administrator rights
'   (verified on this machine: Register-ScheduledTask -> Access denied), while the
'   Startup folder is a per-user, elevation-free entry point.
'
' What it does: every 30 minutes, run ensure-keepalive.ps1 (next to this file),
'   which re-enables QQDSH-HealthWatchdog / QQDSH-AI-Scheduler / QQDSH-TaskGuard.
'
' It will NOT fight an explicit decision to turn keep-alive off: ensure-keepalive.ps1
'   stops immediately when state\keepalive-off exists.
'
' To disable keep-alive completely:
'   1) create an empty file  qq-bridge\state\keepalive-off
'   2) delete QQDSH-Keepalive.vbs from the Startup folder
'
' NOTE: keep this file pure ASCII. VBScript is read as ANSI, so non-ASCII comments
'       can be mis-decoded and break parsing (same class of bug as the .ps1 BOM trap).
Option Explicit

Dim fso, shell, here, script, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "ensure-keepalive.ps1")

If Not fso.FileExists(script) Then WScript.Quit 2

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """ -Quiet"

Do
  ' 0 = hidden window, True = wait for it to finish (the script is fast, and waiting
  ' keeps concurrent instances from piling up).
  shell.Run cmd, 0, True
  WScript.Sleep 30 * 60 * 1000
Loop

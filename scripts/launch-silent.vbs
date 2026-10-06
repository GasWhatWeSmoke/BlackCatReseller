' Black Cat Reseller - windowless launcher (what the desktop shortcut points at).
'
' Double-clicking the .cmd opens a console window and keeps it on screen for the
' whole life of the app. wscript runs the SAME PowerShell launcher with the window
' hidden, so the app starts like any other Windows program. Startup progress and
' any failure land in var\logs\launch.log, and a fatal error raises a dialog.
'
' "Launch Black Cat Agent.cmd" is still the console version - use it when you want
' to watch the build and server output.
Option Explicit
Dim shell, fso, here, ps1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "launch.ps1")
If Not fso.FileExists(ps1) Then
  MsgBox "Cannot find:" & vbCrLf & ps1, vbCritical, "Black Cat Reseller"
  WScript.Quit 1
End If
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
      "-WindowStyle Hidden -File """ & ps1 & """ -Silent"
shell.Run cmd, 0, False

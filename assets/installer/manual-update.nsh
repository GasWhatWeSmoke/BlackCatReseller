; Manual updates must wait for the user to quit; never terminate resale work.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${nsProcess::Unload}
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Black Cat is still running. Finish your work, choose Quit from the Black Cat tray menu, then run this installer again." /SD IDOK
    SetErrorLevel 10
    Quit
  ${ElseIf} $R0 != 603
    MessageBox MB_OK|MB_ICONSTOP "Setup could not check whether Black Cat is running. Restart Windows and try again before changing the installed program." /SD IDOK
    SetErrorLevel 11
    Quit
  ${EndIf}
!macroend

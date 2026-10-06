@echo off
rem One-time setup for Black Cat Reseller. Double-click after unzipping.
rem Installs the private photo worker in persistent user storage, never resources/app.
title Black Cat Reseller - one-time setup
echo.
echo  Setting up Black Cat Reseller (this can take a few minutes)...
echo.
if not defined BLACKCAT_RUNTIME_ROOT (
  if defined BLACKCAT_DATA_ROOT (
    set "BLACKCAT_RUNTIME_ROOT=%BLACKCAT_DATA_ROOT%\runtime"
  ) else (
    set "BLACKCAT_RUNTIME_ROOT=%USERPROFILE%\BlackCatAgent\var\runtime"
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\app\worker\setup.ps1" -RuntimeRoot "%BLACKCAT_RUNTIME_ROOT%"
if errorlevel 1 (
  echo.
  echo  Setup FAILED - review the error above before trying again.
) else (
  echo.
  echo  Setup complete! You can now run "Black Cat Reseller.exe".
)
echo.
pause

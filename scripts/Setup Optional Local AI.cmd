@echo off
setlocal
title Black Cat Reseller - optional local AI
echo.
echo  Optional NVIDIA local AI setup downloads several GB of model and runtime files.
echo  Inventory and manual review work without this optional setup.
echo  Keep this window open. Assets stay in your user folder across app updates.
echo.
if not defined BLACKCAT_RUNTIME_ROOT (
  if defined BLACKCAT_DATA_ROOT (
    set "BLACKCAT_RUNTIME_ROOT=%BLACKCAT_DATA_ROOT%\runtime"
  ) else (
    set "BLACKCAT_RUNTIME_ROOT=%USERPROFILE%\BlackCatAgent\var\runtime"
  )
)
if not defined BLACKCAT_VISION_ROOT set "BLACKCAT_VISION_ROOT=%BLACKCAT_RUNTIME_ROOT%\vision"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\app\scripts\setup-local-vision.ps1" -AssetRoot "%BLACKCAT_VISION_ROOT%"
if errorlevel 1 (
  echo.
  echo  Optional AI setup did not finish. Review the error; manual mode remains available.
) else (
  echo.
  echo  AI assets are ready. Quit Black Cat through its tray menu and reopen it.
  echo  Check the AI status before enabling it, then verify your first real batch.
)
echo.
pause

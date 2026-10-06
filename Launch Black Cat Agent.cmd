@echo off
REM CONSOLE launcher - shows startup/build progress + server log in this window.
REM The desktop shortcut uses scripts\launch-silent.vbs instead, which runs the
REM same thing with no console at all. Use this one when you want to watch it.
title Black Cat Agent
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"

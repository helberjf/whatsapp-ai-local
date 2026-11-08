@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-central.ps1" %*
set "START_EXIT=%ERRORLEVEL%"
if not "%START_EXIT%"=="0" if "%~1"=="" pause
exit /b %START_EXIT%

@echo off
setlocal
cd /d "%~dp0"
node scripts\open-central.cjs %*
set "START_EXIT=%ERRORLEVEL%"
if not "%START_EXIT%"=="0" if "%~1"=="" pause
exit /b %START_EXIT%

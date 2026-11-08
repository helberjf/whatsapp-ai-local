@echo off
setlocal
cd /d "%~dp0"
node scripts\stop-central.cjs
pause

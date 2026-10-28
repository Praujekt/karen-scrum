@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Weekwise needs Node.js 22.13 or newer. Install the LTS version from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause

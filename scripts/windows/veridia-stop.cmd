@echo off
setlocal
set "ROOT=%~dp0..\..\"
set "PM2=%ROOT%node_modules\.bin\pm2.cmd"
set "LOG_DIR=%ROOT%logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%ROOT%"

if not exist "%PM2%" (
  echo Local PM2 is missing.
  exit /b 10
)

call "%PM2%" describe veridia >nul 2>&1
if errorlevel 1 (
  echo VERIDIA is not registered in PM2.
  exit /b 0
)

call "%PM2%" stop veridia >>"%LOG_DIR%\launcher.log" 2>>"%LOG_DIR%\launcher-error.log"
if errorlevel 1 (
  echo VERIDIA stop failed. Check logs\launcher-error.log.
  exit /b 11
)

echo VERIDIA has stopped.
exit /b 0

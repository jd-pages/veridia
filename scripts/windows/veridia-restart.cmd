@echo off
setlocal
set "ROOT=%~dp0..\..\"
set "PM2=%ROOT%node_modules\.bin\pm2.cmd"
set "LOG_DIR=%ROOT%logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%ROOT%"

call "%PM2%" describe veridia >nul 2>&1
if errorlevel 1 (
  call "%ROOT%scripts\windows\veridia-start.cmd"
  exit /b %errorlevel%
)

call "%PM2%" restart veridia --update-env >>"%LOG_DIR%\launcher.log" 2>>"%LOG_DIR%\launcher-error.log"
if errorlevel 1 (
  echo VERIDIA restart failed. Check logs\launcher-error.log and logs\veridia-error.log.
  exit /b 11
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\windows\wait-veridia.ps1" -TimeoutSeconds 60 >>"%LOG_DIR%\launcher.log" 2>>"%LOG_DIR%\launcher-error.log"
if errorlevel 1 (
  echo VERIDIA did not become ready after restart. Check logs\veridia-error.log.
  exit /b 12
)

echo VERIDIA has restarted: http://localhost:3100
exit /b 0

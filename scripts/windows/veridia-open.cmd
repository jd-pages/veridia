@echo off
setlocal
set "ROOT=%~dp0..\..\"
set "LOG_DIR=%ROOT%logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%ROOT%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\windows\wait-veridia.ps1" -TimeoutSeconds 2 >nul 2>&1
if errorlevel 1 (
  echo VERIDIA is not running. Starting it in the background...
  call "%ROOT%scripts\windows\veridia-start.cmd"
  if errorlevel 1 (
    echo VERIDIA could not start. Check logs\launcher-error.log and logs\veridia-error.log.
    pause
    exit /b 11
  )
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\windows\wait-veridia.ps1" -TimeoutSeconds 60 >>"%LOG_DIR%\launcher.log" 2>>"%LOG_DIR%\launcher-error.log"
if errorlevel 1 (
  echo VERIDIA is not ready. Check logs\launcher-error.log.
  pause
  exit /b 12
)

start "" "http://localhost:3100"
exit /b 0

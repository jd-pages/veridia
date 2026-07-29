@echo off
setlocal
set "ROOT=%~dp0..\..\"
set "PM2=%ROOT%node_modules\.bin\pm2.cmd"
set "LOG_DIR=%ROOT%logs"
set "LAUNCH_LOG=%LOG_DIR%\launcher.log"
set "ERROR_LOG=%LOG_DIR%\launcher-error.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%ROOT%"
echo [%date% %time%] Manual start requested.>>"%LAUNCH_LOG%"

if not exist "%PM2%" (
  echo VERIDIA start failed: local PM2 is missing. Run npm.cmd install.
  echo [%date% %time%] ERROR: Local PM2 is missing.>>"%ERROR_LOG%"
  exit /b 10
)

if not exist "%ROOT%.next\BUILD_ID" (
  echo VERIDIA start failed: production build is missing. Run npm.cmd run build.
  echo [%date% %time%] ERROR: Production build is missing.>>"%ERROR_LOG%"
  exit /b 11
)

call "%PM2%" startOrReload "%ROOT%ecosystem.config.cjs" --only veridia --update-env >>"%LAUNCH_LOG%" 2>>"%ERROR_LOG%"

if errorlevel 1 (
  echo VERIDIA start failed. Check logs\launcher-error.log and logs\veridia-error.log.
  call "%PM2%" logs veridia --err --lines 50 --nostream >>"%ERROR_LOG%" 2>&1
  exit /b 12
)

call "%PM2%" save --force >>"%LAUNCH_LOG%" 2>>"%ERROR_LOG%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\windows\wait-veridia.ps1" -TimeoutSeconds 60 >>"%LAUNCH_LOG%" 2>>"%ERROR_LOG%"
if errorlevel 1 (
  echo VERIDIA process was submitted but the website is not ready. Check logs\veridia-error.log.
  call "%PM2%" logs veridia --lines 50 --nostream >>"%ERROR_LOG%" 2>&1
  exit /b 13
)

echo VERIDIA is running in the background: http://localhost:3100
exit /b 0

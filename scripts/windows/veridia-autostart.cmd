@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0..\..\"
set "PM2=%ROOT%node_modules\.bin\pm2.cmd"
set "LOG_DIR=%ROOT%logs"
set "LAUNCH_LOG=%LOG_DIR%\launcher.log"
set "ERROR_LOG=%LOG_DIR%\launcher-error.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%ROOT%"

echo [%date% %time%] Windows auto-start requested.>>"%LAUNCH_LOG%"

if not exist "%PM2%" (
  echo [%date% %time%] ERROR: Local PM2 is missing. Run npm.cmd install.>>"%ERROR_LOG%"
  exit /b 10
)

if not exist "%ROOT%.next\BUILD_ID" (
  echo [%date% %time%] ERROR: Production build is missing. Run npm.cmd run build.>>"%ERROR_LOG%"
  exit /b 11
)

call "%PM2%" startOrReload "%ROOT%ecosystem.config.cjs" --only veridia --update-env >>"%LAUNCH_LOG%" 2>>"%ERROR_LOG%"
if errorlevel 1 exit /b 12

call "%PM2%" save --force >>"%LAUNCH_LOG%" 2>>"%ERROR_LOG%"
exit /b %errorlevel%

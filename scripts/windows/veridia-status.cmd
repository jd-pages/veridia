@echo off
setlocal
set "ROOT=%~dp0..\..\"
set "PM2=%ROOT%node_modules\.bin\pm2.cmd"
cd /d "%ROOT%"

if not exist "%PM2%" (
  echo Local PM2 is missing.
  pause
  exit /b 10
)

call "%PM2%" status veridia
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3100/login' -UseBasicParsing -TimeoutSec 3; Write-Host ('HTTP status: ready (' + $r.StatusCode + ')') -ForegroundColor Green; exit 0 } catch { Write-Host ('HTTP status: unavailable - ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
echo.
echo URL: http://localhost:3100
echo Logs: %ROOT%logs
pause

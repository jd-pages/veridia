@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Local Preview

node scripts\fixed-workflow.mjs preview %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" echo Local preview did not start. Review the message above.
pause
exit /b %VERIDIA_EXIT_CODE%

@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Local Package Acceptance

node scripts\fixed-workflow.mjs package %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" echo Local package acceptance stopped. Nothing was published.
pause
exit /b %VERIDIA_EXIT_CODE%

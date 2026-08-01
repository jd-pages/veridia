@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Publish Release

node scripts\fixed-workflow.mjs publish %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" echo Release stopped. No automatic retry will be attempted.
pause
exit /b %VERIDIA_EXIT_CODE%

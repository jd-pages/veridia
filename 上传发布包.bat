@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title VERIDIA Binary Publish Resume

echo ========================================
echo VERIDIA Binary Publish / Resume
echo ========================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 goto node_missing

node scripts\software-binary-publish.mjs %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" echo Binary publish stopped. Draft Release remains unchanged.
pause
exit /b %VERIDIA_EXIT_CODE%

:node_missing
echo Node.js was not found. VERIDIA binary publish cannot start.
echo Install Node.js and add it to PATH.
echo.
pause
exit /b 1

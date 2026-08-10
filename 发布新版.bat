@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title VERIDIA Software Release

echo ========================================
echo VERIDIA Software Release
echo ========================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 goto node_missing

node scripts\software-publish-orchestrator.mjs %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%VERIDIA_EXIT_CODE%"=="0" goto publish_success
node scripts\software-publish-bat-tail.mjs failure
goto publish_finish

:publish_success
node scripts\software-publish-bat-tail.mjs success

:publish_finish

echo.
pause
exit /b %VERIDIA_EXIT_CODE%

:node_missing
echo Node.js was not found. VERIDIA release cannot start.
echo Install Node.js and add it to PATH.
echo.
pause
exit /b 1

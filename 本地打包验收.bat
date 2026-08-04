@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Local Package Acceptance

if exist "E:\DevCache\ms-playwright" (
  set "PLAYWRIGHT_BROWSERS_PATH=E:\DevCache\ms-playwright"
)

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  set "PLAYWRIGHT_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
)

echo Playwright browsers path: %PLAYWRIGHT_BROWSERS_PATH%
echo Playwright executable path: %PLAYWRIGHT_EXECUTABLE_PATH%
echo.

node scripts\fixed-workflow.mjs package %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" echo Local package acceptance stopped. Nothing was published.
pause
exit /b %VERIDIA_EXIT_CODE%

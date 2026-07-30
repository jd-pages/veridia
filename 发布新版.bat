@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Release

set "RELEASE_CHOICE="
set "VERIDIA_RELEASE_TYPE="

if /i "%~1"=="--dry-run" set "VERIDIA_RELEASE_DRY_RUN=1"
if "%VERIDIA_RELEASE_DRY_RUN%"=="1" set "RELEASE_CHOICE=%~2"

echo.
echo ========================================
echo VERIDIA Local Release
echo ========================================
echo Select release type:
echo   1. Patch release, for example 1.0.2 to 1.0.3
echo   2. Minor release, for example 1.0.0 to 1.1.0
echo   3. Major release, for example 1.0.0 to 2.0.0
echo.
if not defined RELEASE_CHOICE set /p "RELEASE_CHOICE=Enter 1, 2 or 3: "

if "%RELEASE_CHOICE%"=="1" set "VERIDIA_RELEASE_TYPE=patch"
if "%RELEASE_CHOICE%"=="2" set "VERIDIA_RELEASE_TYPE=minor"
if "%RELEASE_CHOICE%"=="3" set "VERIDIA_RELEASE_TYPE=major"

if not defined VERIDIA_RELEASE_TYPE goto :invalid_choice
if "%VERIDIA_RELEASE_DRY_RUN%"=="1" goto :dry_run

echo.
echo Selected release type: %VERIDIA_RELEASE_TYPE%
echo Starting local checks, version update and installer build.
echo This script does not create Git tags or GitHub releases.
echo This script does not publish rule packages.
echo.

call npm.cmd run release:%VERIDIA_RELEASE_TYPE%
if errorlevel 1 goto :release_failed

echo.
echo Local build completed.
echo Check the release directory for installers, update files and logs.
pause
exit /b 0

:dry_run
echo.
echo ========================================
echo Dry-run passed
echo ========================================
echo Menu choice: %RELEASE_CHOICE%
echo Release type: %VERIDIA_RELEASE_TYPE%
echo npm was not started and the version was not changed.
echo No installer, tag, release or upload was created.
exit /b 0

:invalid_choice
echo.
echo Invalid choice. Release cancelled.
echo Enter 1, 2 or 3.
pause
exit /b 1

:release_failed
echo.
echo Release failed.
echo The version change is rolled back. Check .release-work\logs.
pause
exit /b 1

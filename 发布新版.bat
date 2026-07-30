@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Release

set "RELEASE_CHOICE="
set "VERIDIA_RELEASE_TYPE="
set "PUBLISH_CHOICE="

if /i "%~1"=="--dry-run" goto :dry_run_menu

call node scripts\finalize-release.mjs pending
if errorlevel 2 goto :release_menu
if errorlevel 1 goto :precheck_failed

echo.
echo A complete unpublished local release already exists.
set /p "PUBLISH_CHOICE=Publish this existing release now? Y/N: "
if /i "%PUBLISH_CHOICE%"=="Y" goto :publish_existing
if /i "%PUBLISH_CHOICE%"=="N" goto :local_only
goto :invalid_publish_choice

:release_menu
echo.
echo ========================================
echo VERIDIA One-Click Release
echo ========================================
echo Select release type:
echo   1. Patch release
echo   2. Minor release
echo   3. Major release
echo.
set /p "RELEASE_CHOICE=Enter 1, 2 or 3: "

if "%RELEASE_CHOICE%"=="1" set "VERIDIA_RELEASE_TYPE=patch"
if "%RELEASE_CHOICE%"=="2" set "VERIDIA_RELEASE_TYPE=minor"
if "%RELEASE_CHOICE%"=="3" set "VERIDIA_RELEASE_TYPE=major"
if not defined VERIDIA_RELEASE_TYPE goto :invalid_release_choice

echo.
echo Selected release type: %VERIDIA_RELEASE_TYPE%
echo Starting checks, version update and installer build.
call npm.cmd run release:%VERIDIA_RELEASE_TYPE%
if errorlevel 1 goto :build_failed

call node scripts\finalize-release.mjs summary
if errorlevel 1 goto :summary_failed

echo.
set /p "PUBLISH_CHOICE=Publish to GitHub Release now? Y/N: "
if /i "%PUBLISH_CHOICE%"=="Y" goto :publish_existing
if /i "%PUBLISH_CHOICE%"=="N" goto :local_only
goto :invalid_publish_choice

:publish_existing
echo.
echo Publishing the current local release to GitHub.
call node scripts\finalize-release.mjs publish
if errorlevel 1 goto :publish_failed
echo.
echo GitHub Release completed and verified.
pause
exit /b 0

:local_only
echo.
echo Local installer retained. No Tag or GitHub Release was created.
pause
exit /b 0

:dry_run_menu
set "RELEASE_CHOICE=%~2"
if "%RELEASE_CHOICE%"=="1" set "VERIDIA_RELEASE_TYPE=patch"
if "%RELEASE_CHOICE%"=="2" set "VERIDIA_RELEASE_TYPE=minor"
if "%RELEASE_CHOICE%"=="3" set "VERIDIA_RELEASE_TYPE=major"
if not defined VERIDIA_RELEASE_TYPE exit /b 1
echo Dry-run passed.
echo Release type: %VERIDIA_RELEASE_TYPE%
echo No build, version change, Tag, Release or upload was created.
exit /b 0

:invalid_release_choice
echo.
echo Invalid release choice. Enter 1, 2 or 3.
pause
exit /b 1

:invalid_publish_choice
echo.
echo Invalid publish choice. Enter Y or N.
pause
exit /b 1

:precheck_failed
echo.
echo Existing-release precheck failed. Nothing was changed.
pause
exit /b 1

:build_failed
echo.
echo Build failed. The version change was rolled back.
echo Check .release-work\logs for details.
pause
exit /b 1

:summary_failed
echo.
echo Artifact summary validation failed. Nothing was published.
pause
exit /b 1

:publish_failed
echo.
echo GitHub publish or remote verification failed.
echo Local installers and source files were retained.
pause
exit /b 1

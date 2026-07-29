@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title VERIDIA 发布新版

echo.
echo 请选择发布类型：
echo   1. 补丁版本（patch，例如 1.0.0 -^> 1.0.1）
echo   2. 功能版本（minor，例如 1.0.0 -^> 1.1.0）
echo   3. 重大版本（major，例如 1.0.0 -^> 2.0.0）
echo.
set /p VERIDIA_RELEASE_CHOICE=请输入 1、2 或 3：

if "%VERIDIA_RELEASE_CHOICE%"=="1" set VERIDIA_RELEASE_TYPE=patch
if "%VERIDIA_RELEASE_CHOICE%"=="2" set VERIDIA_RELEASE_TYPE=minor
if "%VERIDIA_RELEASE_CHOICE%"=="3" set VERIDIA_RELEASE_TYPE=major

if not defined VERIDIA_RELEASE_TYPE (
  echo 无效选择，发布已取消。
  pause
  exit /b 1
)

call npm.cmd run release:%VERIDIA_RELEASE_TYPE%
if errorlevel 1 (
  echo.
  echo 发布失败。正式版本号未升级，请查看 .release-work\logs。
  pause
  exit /b 1
)

echo.
echo 本地发布完成。请检查 release 目录中的安装包和更新文件。
pause

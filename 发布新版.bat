@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA Publish Release

echo 正在检查软件发布必需文件：EXE、blockmap、latest.yml...
node scripts\validate-software-release.mjs %*
if errorlevel 1 (
  echo.
  echo 软件发布已停止。没有创建 Tag、Release，也没有上传任何文件。
  echo 本流程不会运行规则发布命令，也不会发布远程规则。
  pause
  exit /b 1
)

node scripts\fixed-workflow.mjs publish %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" echo 软件发布已停止，不会自动重试或上传不完整文件。
pause
exit /b %VERIDIA_EXIT_CODE%

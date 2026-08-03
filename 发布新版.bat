@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 936 >nul
cd /d "%~dp0"
title VERIDIA Publish Release

set "VERIDIA_RELEASE_LOG_DIR=%CD%\.release-work\logs"
set "VERIDIA_RELEASE_LOG=%VERIDIA_RELEASE_LOG_DIR%\software-release-bat.log"

if not exist "%VERIDIA_RELEASE_LOG_DIR%" mkdir "%VERIDIA_RELEASE_LOG_DIR%" >nul 2>&1
>"%VERIDIA_RELEASE_LOG%" echo VERIDIA software release diagnostics
>>"%VERIDIA_RELEASE_LOG%" echo Project: %CD%
>>"%VERIDIA_RELEASE_LOG%" echo Arguments: %*

where node >nul 2>&1
if errorlevel 1 goto node_missing

echo 正在检查软件发布必需文件：EXE、blockmap、latest.yml...
node scripts\validate-software-release.mjs %* 2>>"%VERIDIA_RELEASE_LOG%"
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"
>>"%VERIDIA_RELEASE_LOG%" echo Validation exit code: %VERIDIA_EXIT_CODE%
if not "%VERIDIA_EXIT_CODE%"=="0" goto validation_failed

echo.
echo 发布前检查已通过，下面将进入软件发布确认流程。
echo 诊断日志：%VERIDIA_RELEASE_LOG%
node scripts\fixed-workflow.mjs publish %* 2>>"%VERIDIA_RELEASE_LOG%"
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"
>>"%VERIDIA_RELEASE_LOG%" echo Workflow exit code: %VERIDIA_EXIT_CODE%
if not "%VERIDIA_EXIT_CODE%"=="0" goto workflow_failed

echo.
echo 软件发布流程已正常结束。
echo 诊断日志：%VERIDIA_RELEASE_LOG%
pause
exit /b 0

:node_missing
>>"%VERIDIA_RELEASE_LOG%" echo Error: Node.js was not found in PATH.
echo.
echo 软件发布已停止：找不到 Node.js。
echo 请安装 Node.js 并确认 node 已加入 PATH。
echo 诊断日志：%VERIDIA_RELEASE_LOG%
pause
exit /b 1

:validation_failed
echo.
echo 软件发布已停止：发布前检查未通过。
call :show_log
echo 请查看上方具体原因或诊断日志：%VERIDIA_RELEASE_LOG%
echo 没有创建 Tag、Release，也没有上传任何文件。
echo 本流程不会运行规则发布命令，也不会发布远程规则。
pause
exit /b %VERIDIA_EXIT_CODE%

:workflow_failed
echo.
echo 软件发布已停止：发布流程返回错误。
call :show_log
echo 请查看上方具体原因或诊断日志：%VERIDIA_RELEASE_LOG%
echo 不会自动重试或上传不完整文件。
pause
exit /b %VERIDIA_EXIT_CODE%

:show_log
echo.
echo ---------- 诊断日志 ----------
powershell.exe -NoProfile -Command "Get-Content -LiteralPath $env:VERIDIA_RELEASE_LOG -Encoding UTF8"
echo ---------- 日志结束 ----------
exit /b 0

@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title VERIDIA 正式发布

echo ========================================
echo VERIDIA 正式发布
echo ========================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 goto node_missing

node scripts\software-publish-orchestrator.mjs %*
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" (
  echo VERIDIA 正式发布未完成，请根据上方中文错误摘要和日志处理。
  echo 没有自动重试、reset、覆盖 Tag，也没有执行 rules:publish。
) else (
  echo VERIDIA 发布入口已正常结束。
  echo 本次未执行 rules:publish，本次未发布远程规则。
)

echo.
pause
exit /b %VERIDIA_EXIT_CODE%

:node_missing
echo 未找到 Node.js，无法启动 VERIDIA 正式发布。
echo 请确认 Node.js 已安装并加入 PATH。
echo.
pause
exit /b 1

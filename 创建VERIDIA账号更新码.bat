@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

if not exist "node_modules\.bin\tsx.cmd" goto :missing_dependencies
if not exist "scripts\account-developer-tool.ts" goto :missing_tool

set "ACCOUNT_PRIVATE_KEY=%VERIDIA_ACCOUNT_SIGNING_KEY_PATH%"
if not defined ACCOUNT_PRIVATE_KEY set "ACCOUNT_PRIVATE_KEY=%LOCALAPPDATA%\VERIDIA-Developer-Secrets\account-signing-ed25519-private.pem"
if not exist "%ACCOUNT_PRIVATE_KEY%" goto :missing_private_key

echo.
echo ========================================
echo VERIDIA 账号更新码创建工具
echo ========================================
echo.
call npx.cmd tsx scripts/account-developer-tool.ts update
if errorlevel 1 goto :run_failed

echo.
echo 账号更新码创建流程已完成。
pause
exit /b 0

:missing_dependencies
echo.
echo [错误] 未找到 node_modules 或 tsx。
echo 请先在项目目录运行：
echo npm.cmd install
goto :failed

:missing_tool
echo.
echo [错误] 未找到 scripts/account-developer-tool.ts。
echo 请确认当前目录是 VERIDIA 项目根目录。
goto :failed

:missing_private_key
echo.
echo [错误] 未找到账号签名私钥：
echo %ACCOUNT_PRIVATE_KEY%
echo.
echo 请先运行初始化密钥命令：
echo npx.cmd tsx scripts/account-developer-tool.ts init-key
goto :failed

:run_failed
echo.
echo [错误] 创建账号更新码失败，请检查上方提示。

:failed
echo.
pause
exit /b 1

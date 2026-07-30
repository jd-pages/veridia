@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo 正在检查并发布 VERIDIA 规则新版...
echo 发布权限仅使用本机 GitHub CLI 登录，不会写入安装包。
call npm.cmd run rules:publish
if errorlevel 1 (
  echo.
  echo 规则发布失败。上一版远程规则未被覆盖。
  pause
  exit /b 1
)

echo.
echo 规则发布完成。
pause

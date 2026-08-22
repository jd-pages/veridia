@echo off
chcp 936 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
set "VERIDIA_RULES_REPOSITORY=jd-pages/veridia-rules"
set "VERIDIA_RULE_PROJECT_SOURCE="
title VERIDIA 远程规则发布

echo.
echo VERIDIA 远程规则发布
echo 当前目录：%CD%
if defined VERIDIA_RULE_DATABASE_PATH (
  echo 规则来源：显式数据库 override
  echo VERIDIA_RULE_DATABASE_PATH=%VERIDIA_RULE_DATABASE_PATH%
) else (
  echo 规则来源：自动解析当前 VERIDIA Desktop 正式数据库
  echo 路径配置：%%LOCALAPPDATA%%\VERIDIA\config\data-location.json
)
echo 注意：不会回退发布 rules\default-rules.json；找不到正式数据库会直接停止。

echo.
echo 即将执行 npm.cmd run rules:publish
echo 实际数据库路径、规则版本和各类规则数量将在发布前显示。
echo 发布权限仅使用本机 GitHub CLI 登录，不会写入安装包。
call npm.cmd run rules:publish
set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%VERIDIA_EXIT_CODE%"=="0" (
  echo 规则发布失败，退出码 %VERIDIA_EXIT_CODE%。
  echo 上一版远程规则未被覆盖。
) else (
  echo 规则发布完成。
)

echo.
pause
exit /b %VERIDIA_EXIT_CODE%

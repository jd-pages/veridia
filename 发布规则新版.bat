@echo off
chcp 936 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
set "VERIDIA_RULES_REPOSITORY=jd-pages/veridia-rules"
title VERIDIA 发布规则新版

rem 默认使用项目内 rules/default-rules.json。
rem 如需从明确指定的数据库发布，请取消下一行注释并修改路径：
rem set "VERIDIA_RULE_DATABASE_PATH=E:\xxx\data\veridia.db"

echo.
echo VERIDIA 远程规则发布
echo 当前目录：%CD%
if defined VERIDIA_RULE_DATABASE_PATH (
  echo 规则来源：指定数据库
  echo VERIDIA_RULE_DATABASE_PATH=%VERIDIA_RULE_DATABASE_PATH%
) else (
  echo 规则来源：项目内 rules/default-rules.json
  echo VERIDIA_RULE_DATABASE_PATH：未设置
)

echo.
echo 即将执行 npm.cmd run rules:publish
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

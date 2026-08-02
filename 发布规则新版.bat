@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions DisableDelayedExpansion
title VERIDIA 发布规则新版

echo(正在检查 VERIDIA 本地规则数据库结构...
call npm.cmd run rules:db:preflight
if errorlevel 1 (
  echo(
  echo(数据库检查或迁移失败，规则发布已停止。
  echo(远程旧规则未被覆盖，也没有上传新的规则包。
  pause
  exit /b 1
)

echo(
echo(数据库迁移完成，可以重新发布规则。
echo(正在验证本地规则数据能否完整读取...
call npm.cmd run rules:validate-local
if errorlevel 1 (
  echo(
  echo(本地规则数据读取失败，规则发布已停止。
  echo(远程旧规则未被覆盖，也没有上传新的规则包。
  pause
  exit /b 1
)

echo(
echo(正在检查并发布 VERIDIA 规则新版...
echo(发布权限仅使用本机 GitHub CLI 登录，不会写入安装包。
call npm.cmd run rules:publish
if errorlevel 1 (
  echo(
  echo(规则发布失败。上一版远程规则未被覆盖。
  pause
  exit /b 1
)

echo(
echo(规则发布完成。
pause
exit /b 0

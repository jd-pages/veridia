$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath "node_modules")) {
  Write-Host "首次运行，正在安装依赖..."
  & npm.cmd install
}

if (-not (Test-Path -LiteralPath "prisma\dev.db")) {
  & powershell.exe -ExecutionPolicy Bypass -File "scripts\init-db.ps1"
}

Write-Host "启动完成后请访问 http://localhost:3100"
& npm.cmd run dev

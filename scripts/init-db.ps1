$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Write-Host "正在生成 Prisma Client..."
& npm.cmd run db:generate

Write-Host "正在应用数据库迁移..."
& npm.cmd run db:ensure
& npm.cmd run db:deploy

Write-Host "正在写入测试数据..."
& npm.cmd run db:seed

Write-Host "正在生成 Excel 导入模板..."
& npm.cmd run excel:template

Write-Host "数据库初始化完成。"

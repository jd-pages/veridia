# VERIDIA 更新日志

## 1.0.1 - 2026-07-29

- 修复 Windows 安装版遗漏 `node_modules/.prisma/client` 导致后台服务无法启动的问题。
- 在生产构建和桌面打包前强制生成、复制并检查 Prisma Client 运行文件。
- 增加 Next.js standalone Prisma 文件追踪和 Electron 打包后断言。

## 1.0.0 - 2026-07-29

- 建立 VERIDIA Windows 桌面应用、固定规则审核与本地数据持久化基础。
- 建立可回滚数据库迁移、自动更新和安装包发布机制。

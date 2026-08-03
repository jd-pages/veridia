# VERIDIA Windows 发布与更新

## 日常开发

推送到 `main` 时，`veridia-ci.yml` 只执行 TypeScript、ESLint、单元测试、
隔离数据库端到端测试和 Next.js 生产构建，不创建 Release。

## 本地确认发布

按变更范围运行以下命令之一：

```powershell
npm run release:patch
npm run release:minor
npm run release:major
```

也可以双击根目录的 `发布新版.bat`。命令会先完成全部检查；只有检查通过后才修改
`package.json`、`package-lock.json` 和 `CHANGELOG.md`。最终桌面构建失败时会恢复这些文件。

成功后：

1. 验收 `release\<版本号>\VERIDIA-Setup-<版本号>.exe`。
2. 提交源码、版本文件和更新日志。
3. 运行 `npm run release:tag`。
4. 推送提示中的 `v<版本号>` Tag。
5. GitHub Actions 创建 Release 并上传 EXE、`latest.yml` 和 blockmap。

## GitHub 手动发布

可在 Actions 的“VERIDIA Windows 发布”中选择 Run workflow，并选择 patch、
minor 或 major。流水线在测试通过后升级版本、构建、将版本文件写回 `main`，
然后创建对应 Release。

## 自动更新

Electron 主进程使用 `electron-updater`：

- 启动后延迟检查，离线失败不影响本地功能。
- 发现新版后显示中文更新说明。
- 用户确认后下载并显示进度。
- 下载完成后由用户决定何时重启安装。
- 同一时间只允许一个检查请求和一个下载任务。
- 更新程序仅覆盖安装目录；`%LOCALAPPDATA%\VERIDIA` 不在更新范围内。
- GitHub provider 使用带版本 Tag 的 Release URL，并从当前版本 Release 读取旧
  blockmap、从目标版本 Release 读取新 blockmap；差分失败时自动回退完整 EXE。
- 下载界面显示已下载大小、总大小、速度、预计剩余时间和差分/完整更新状态。
- updater 诊断信息写入本地数据目录的 `logs\desktop.log`，可搜索
  `Download block maps`、`differential` 和 `fallback to full download`。

每个软件 Release 必须同时上传 EXE、同名 `.exe.blockmap` 和 `latest.yml`。当前公开
GitHub 仓库由客户端匿名读取；禁止把 GitHub Token 写入桌面应用。如果未来改为私有仓库，
需要另行部署客户端可读取且能保留历史版本 blockmap 的 HTTPS 更新服务。

## 数据库迁移与回滚

启动新版本前，桌面主进程将当前数据库复制到 `backups`，执行 `prisma migrate deploy`
并检查迁移状态。失败时恢复备份且不启动业务服务。安装器或更新器不会创建空白数据库覆盖已有数据。

## 代码签名

GitHub 仓库 Secrets：

- `WINDOWS_CSC_LINK`：Base64 编码证书或安全证书地址。
- `WINDOWS_CSC_KEY_PASSWORD`：证书密码。

本地签名使用 electron-builder 标准环境变量 `CSC_LINK` 和 `CSC_KEY_PASSWORD`。
没有证书时生成未签名内部测试包，Windows 可能显示“未知发布者”。

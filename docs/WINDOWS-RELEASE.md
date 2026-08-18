# VERIDIA Windows 发布与更新

## 日常开发

推送到 `main` 时，`veridia-ci.yml` 只执行 TypeScript、ESLint、单元测试、
隔离数据库端到端测试和 Next.js 生产构建，不创建 Release。

## 正式软件发布

唯一用户入口是双击根目录的 `发布新版.bat`，核对计划后输入 `Y`。发布器统一读取
`ReleaseState`，依次完成 Preflight、FULL、Package、本地产物校验、Release Commit、
Push main、Main CI、Tag、GitHub Release Workflow 和远端三件套校验。正常结束必须显示
`RELEASE = PASS`。

发布器持久化单调 Checkpoint。网络或进程中断后仍然重新运行同一个 BAT；它会先审计
HEAD、origin/main、Main CI、Tag、Workflow、Release 和产物指纹，再从安全阶段继续。
不要手工创建或移动 Tag，不要手工创建 Release，也不要用 reset、rebase 或 force push
“修复”发布状态。

只有明确只读、幂等的网络查询允许在 `TRANSIENT_NETWORK` 时自动重试一次；Push main、
创建/Push Tag、创建 Release 和上传资产都不会自动重试。远程 Tag 一旦 Push，该版本即被
消费；后续 Workflow 确定失败时保留为 `FAILED_RELEASE_TAG`，修复代码后使用下一版本。

本地 FULL 已包含唯一一次 Next.js Production Build，随后 Package 直接复用；正式
GitHub Release Workflow 仍在独立 clean runner 上重新执行一次 FULL、Build、Package 和
资产校验，不信任开发机产物。Main CI 凭证不替代 BAT FULL，因为本地打包环境、依赖与
正式产物绑定无法仅由 CI 结果完整证明。

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
- 更新源使用 GitHub Published Latest Release；只有 Tag、没有 Published Release 的
  `FAILED_RELEASE_TAG` 不会被客户端识别为更新版本。
- 下载界面显示已下载大小、总大小、速度、预计剩余时间和差分/完整更新状态。
- updater 诊断信息写入本地数据目录的 `logs\desktop.log`，可搜索
  `Download block maps`、`differential` 和 `fallback to full download`。

每个软件 Release 必须同时上传 EXE、同名 `.exe.blockmap` 和 `latest.yml`。当前公开
GitHub 仓库由客户端匿名读取；禁止把 GitHub Token 写入桌面应用。如果未来改为私有仓库，
需要另行部署客户端可读取且能保留历史版本 blockmap 的 HTTPS 更新服务。

Release 完成前会校验公开、非 Draft、非 Prerelease、Latest 指向、版本、文件名、大小、
SHA-512、blockmap 和 `latest.yml`。任一项不一致都不能进入 `RELEASE_COMPLETE`。

## 数据库迁移与回滚

启动新版本前，桌面主进程将当前数据库复制到 `backups`，执行 `prisma migrate deploy`
并检查迁移状态。失败时恢复备份且不启动业务服务。安装器或更新器不会创建空白数据库覆盖已有数据。

## 代码签名

GitHub 仓库 Secrets：

- `WINDOWS_CSC_LINK`：Base64 编码证书或安全证书地址。
- `WINDOWS_CSC_KEY_PASSWORD`：证书密码。

本地签名使用 electron-builder 标准环境变量 `CSC_LINK` 和 `CSC_KEY_PASSWORD`。
没有证书时生成未签名内部测试包，Windows 可能显示“未知发布者”。

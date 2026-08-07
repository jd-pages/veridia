# 小红书笔记合规审核系统协作约定

## 项目目标

维护一个 Windows 优先、可本地运行的内部运营后台。硬性合规规则必须确定性执行；AI 仅提供辅助语义判断，任何 AI 失败不得影响固定规则审核。

## 技术约定

- Next.js App Router + TypeScript + Ant Design。
- Prisma 作为唯一数据库访问层；开发使用 SQLite，生产兼容 schema 位于 `prisma/schema.postgresql.prisma`。
- API 返回统一 `{ success, data?, error? }` 结构。
- 产品、活动、话题和规则不得硬编码在业务逻辑中；仅 Seed 可包含演示数据。
- 话题进入系统前必须通过 `normalizeTopic` 规范化。
- 审核完成时保存规则版本与规则快照，禁止用新规则重算并覆盖历史结果。
- OpenAI Key 只允许从服务端环境变量读取，不得写入日志、响应、浏览器代码或数据库。
- 浏览器插件不得绕过登录、验证码、访问控制或风控，也不得实现高频抓取。

## 常用命令

- 安装：`npm.cmd install`
- 初始化：`npm.cmd run setup`
- 开发：`npm.cmd run dev`
- 类型检查：`npm.cmd run typecheck`
- Lint：`npm.cmd run lint`
- 单元测试：`npm.cmd test`
- E2E：`npm.cmd run test:e2e`
- 构建：`npm.cmd run build`

## 修改后验证

核心规则改动至少运行单元测试；数据库或 API 改动运行类型检查与相关集成测试；UI 流程改动运行 Playwright E2E。不要提交 `.env`、数据库文件、测试报告或完整提取隐私数据。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

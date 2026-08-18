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

### 风险分级与默认门禁

每次开始测试前必须先向用户输出：

- `【本次风险等级】LOW / MEDIUM / HIGH`
- `【选择原因】`：列出主要改动文件、受影响测试分类和风险依据。
- `【本轮计划】`：明确会运行的定向测试、E2E 分组和最终门禁，并明确是否不执行 FULL、不 Push、不等待 GitHub CI。

不得以“更保险”为理由自动升级 FULL。升级 FULL 前必须明确输出：`本次升级FULL的原因：...`，且原因必须属于下列 HIGH 范围或来自用户明确要求。

#### LOW：文案与极小展示修改

适用于页面文案、极小 UI 和不影响业务逻辑的展示修改。

默认流程：

1. 定向测试。
2. 按实际影响运行 Typecheck / Lint。
3. `git diff --check`。
4. 创建本地 Commit 后停止。

默认不执行 Regression / FULL，不做连续稳定性循环、不 Push、不等待 GitHub CI、不打包、不发布。目标耗时 10～25 分钟，通常不得超过 30 分钟。

#### MEDIUM：普通业务修改

适用于普通业务逻辑、API、UI 交互，以及不涉及 Schema / Migration 的审核逻辑调整，包括 Import/Results 联动、Duplicate 生命周期、Recheck、Batch 业务状态和多模块联动规则。

默认流程：

1. 定向单元测试。
2. 相关 E2E 单例和所属测试组。
3. Typecheck。
4. Lint。
5. `npm.cmd run verify:regression`。
6. 创建本地 Commit 后停止。

Regression 已包含 Production Build 时不得再单独重复 Build。只有 test matrix 明确要求 FULL 或改动实际属于 HIGH 时，才在代码稳定后追加一次 FULL；不能因为文件数量多而升级。目标耗时 15～35 分钟。

#### HIGH：基础设施、数据库与发布级修改

以下改动默认属于 HIGH：

- Prisma Schema、Migration、数据库升级逻辑。
- Runner、Scheduler、Batch 核心执行基础设施。
- Browser Session、Profile 生命周期。
- 登录、Auth 基础设施。
- Playwright、E2E 基础设施。
- `verify:fast`、`verify:regression`、`verify:full`、测试矩阵和 FULL Attestation。
- `发布新版.bat`、Release orchestration、GitHub Actions 正式发布 Workflow。
- 自动更新核心链路。
- Electron、打包、NSIS 基础设施。
- 用户明确要求完整 FULL 验收的任务。

默认流程为定向测试、必要的 SQLite fresh / legacy 与数据兼容专项验证，确认稳定后直接运行一次 `npm.cmd run verify:full`。FULL 已完整覆盖 Lint、Typecheck、Unit、E2E、Regression 等价检查、Production Build、Standalone、数据库兼容、Sensitive scan 和 git diff check 时，不得先单独执行整套 Regression；只有 FULL 明确缺少某个专项时才补该缺失项。目标耗时 30～60 分钟。修复过程中禁止反复 FULL；FULL 发现问题后先定向修复和验证，稳定后才允许再次执行一轮新的最终 FULL。

### 发布类型：RULE_ONLY 与 SOFTWARE_CHANGE

每个修改必须在验证前先分类，风险等级与发布类型分别判断：

- `RULE_ONLY`：现有软件能力已经支持，仅修改业务规则或配置数据，例如产品、活动、阶段、月份、现有规则参数、店铺话题、已有能力支持的 alias，或使用现有 alias 能力修改正式店名。不修改程序能力、匹配引擎、规则类型或 Schema。通过 `发布规则新版.bat` 发布，不升级 VERIDIA 软件版本。
- `SOFTWARE_CHANGE`：新增程序能力、规则类型或匹配语义，或者修改 resolver、审核引擎、API、UI、Runner、Desktop、Schema、程序 Migration 或发布基础设施。通过 `发布新版.bat` 发布，并升级 VERIDIA 软件版本。

当店铺改名仅需更新正式名称、历史 alias 和店铺话题词，且当前 alias / matcher 能力已支持时，属于 `RULE_ONLY`：保持同一 shop identity，只走 `发布规则新版.bat`，不升级软件版本，也不得为每次改名重复修改 resolver / matcher。只有现有程序能力无法表达新规则时，才分类为 `SOFTWARE_CHANGE`。

### Flaky 测试策略

普通改动默认只要求失败单例成功 1 次、所属测试组成功 1 次，然后进入该风险等级要求的最终门禁。

只有专门修复 flaky、ECONNRESET、页面异步遮挡、Runner race、Browser 生命周期、网络重试，或用户明确要求稳定性验证时才允许连续运行。专门修复 flaky 默认连续 3 次；只有明确高风险或用户指定时才使用 5 次。不得用无限重试、重复 Regression 或重复 FULL 掩盖失败。

### 失败后的增量验证

任意门禁失败时，先读取失败证据，只修复并重跑实际失败项；不得因一个小失败重新执行所有已经通过的门禁。修复完成后，仍须取得该风险等级要求的一次完整最终门禁 PASS。

正式发布前 GitHub CI 失败时，先定位失败 Job、Step 和单例，完成定向修复后再恢复对应门禁。已知问题只在 GitHub Runner 复现时，才把等待远端 CI 作为当前任务的一部分。

### Commit、Push 与远端 CI

普通开发默认 `Commit → 停止`。只有用户明确要求 Push，或任务本身属于发布准备，才允许 Push。

普通任务即使已 Push，也默认汇报同步状态后停止，不等待 GitHub CI。只有正式发布前、修改 CI、测试基础设施、发布系统、已知 GitHub Runner 专属问题，或用户明确要求确认 CI 时才等待远端结果。

### 正式发布与凭证

日常开发按风险等级停在对应门禁，但正式软件发布标准不得降低。`发布新版.bat` 和 GitHub Release Workflow 仍必须执行 FULL、全部单元测试、完整 E2E、Production Build、SQLite fresh/legacy、PostgreSQL validate、Sensitive scan 和 git diff check；纯规则发布使用独立的 `发布规则新版.bat`。

FULL Attestation 继续用于同一 HEAD、同一依赖和同一环境下避免重复本地 FULL。凭证 VALID 时，本地 package acceptance 可以复用；正式 GitHub Release 不得盲信开发机凭证。

正式软件发布与中断恢复只有一个用户入口：`发布新版.bat`。发布器必须使用统一 ReleaseState 和单调 Checkpoint 审计后自动 Resume；禁止指导用户手工创建、移动、覆盖 Tag 或手工补建 Release，也禁止用 reset、rebase、force push 修复发布状态。只有明确只读、幂等且分类为 `TRANSIENT_NETWORK` 的操作允许最多两次有限重试；Push main、创建/Push Tag、创建 Release、上传资产和 `rules:publish` 禁止自动重试。

远程 Tag Push 后版本即被消费。Workflow 确定失败的 Tag 永久保留为 `FAILED_RELEASE_TAG`，不得删除、移动或补建 Release；修复代码后准备下一版本。Updater 只认 Published Latest Release，孤立 Tag 或 Failed Release Tag 不得成为更新版本。UNKNOWN_ORPHAN_TAG、INVALID_RELEASE_STATE 和 UNKNOWN 错误必须阻断，不能猜测继续。

BAT 的本地 FULL 内含唯一一次 Production Build，Package 必须复用该 Build；GitHub Release Workflow 仍须在独立 clean runner 上重新执行一次完整 FULL、Build、Package 和资产校验。Main CI 结果只有在 exact HEAD、版本、依赖和全部输入指纹可严格证明一致时才可复用，否则保留 BAT FULL。

### 避免重复工作

- Regression 已完成 Production Build 时，不再单独 Build。
- FULL 已完成 Build 时，不再重复 Build。
- HIGH 任务在 FULL 等价覆盖 Regression 时，不先执行整套 Regression。
- 只有 Build 后源码内容发生变化，才重新执行 Production Build。
- Migration 与 seed 未变化且 E2E 数据库模板 fingerprint HIT 时，复用隔离副本，不重复初始化模板。
- LOW/MEDIUM 任务超过 45 分钟时，主动检查是否发生重复 FULL、重复 Build、重复 E2E、等待非必要 CI 或无界重试，并停止无意义重复。

核心规则改动至少运行单元测试；数据库或 API 改动运行类型检查与相关集成测试；UI 流程改动运行 Playwright E2E。不要提交 `.env`、数据库文件、测试报告或完整提取隐私数据。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

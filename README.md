# 小红书笔记合规审核系统

面向公司内部运营人员的本地合规审核后台。系统支持多产品、多月份活动与三层话题规则。默认流程由后台 Playwright 专用浏览器自动逐条打开、提取和审核链接；Chrome/Edge 插件保留为失败后的人工补审工具。

固定规则是最终硬性合规依据。Windows 桌面版不连接 OpenAI，不要求 API Key、ChatGPT 登录或任何 AI 服务。

## 已实现功能

- Electron 桌面版固定为 LOCAL 本地账号登录，账号由开发者离线签发并在用户本机激活。
- 仪表盘：本月总量、通过/不通过、待复核、读取失败、通过率和原因排行。
- 产品管理：新增、编辑、停用、搜索、Excel 导入与导出、产品别名。
- 活动管理：按产品/月度配置，新增、编辑、停用、复制下月活动及全部规则。
- 话题规则：全局/产品/活动三层，必须、任意、禁止、品牌通用与别名类型。
- 规则版本与历史快照：规则变化递增活动版本，历史结果保存完整规则快照。
- 自动批量审核：批量粘贴或 Excel 导入后自动创建批次，单线程逐条处理。
- 自动队列控制：等待、处理、暂停、继续、取消、失败重试、登录失效和人工复核。
- 持久化登录：专用 Chrome 用户目录保存小红书登录状态，失效后暂停并支持重新登录。
- 审核引擎：页面、正文有效字数、精确话题、禁止话题、真实可点击话题和公开留存证据。
- 审核结果：组合筛选、分页、批量重新审核、人工结论、当前筛选 Excel 导出。
- 审核详情：原始提取数据、DOM 证据、逐规则结果、人工记录、操作日志。
- Playwright 模拟/真实页面 Adapter 与插件 Adapter 共用 `ExtractedNote` 数据结构。
- Manifest V3 Chrome/Edge 插件用于人工补审、单条重提取和异常页面证据。
- 模拟页面覆盖通过、规则失败、登录失效、删除、无权限、安全验证和结构异常。
- Electron + NSIS Windows 桌面应用、单实例后台服务、托盘与自动更新。
- 独立 GitHub 规则仓库同步，支持签名校验、事务导入、备份和失败回滚。

## 技术架构

- Next.js App Router、TypeScript、Ant Design
- Prisma、SQLite（本地）
- PostgreSQL schema 仅作为历史兼容产物；当前产品不部署中央数据库或中央服务
- ExcelJS、Vitest、Playwright
- Chrome Extension Manifest V3

完整架构和数据表说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## Windows 桌面版

最终用户只需运行 `VERIDIA-Setup-<版本号>.exe`。安装包内含 Electron/Node 运行时、
Next.js 生产构建、Playwright Chromium、SQLite 和 Excel 依赖，不需要安装 Node.js、
npm、PowerShell 或配置 AI。

安装后桌面和开始菜单各创建一个 `VERIDIA` 入口。双击后在隐藏后台启动本地服务并打开
桌面窗口；单实例锁会阻止重复启动。关闭窗口时可选择“最小化到托盘”继续自动审核，
或“退出并停止”安全结束后台服务。

程序固定使用 `%LOCALAPPDATA%\VERIDIA\` 保存用户数据：

```text
data\veridia.db
sessions\xiaohongshu-profile\
config\settings.json
backups\
logs\
```

程序文件升级不会覆盖这些目录。每次数据库迁移前会自动备份，迁移或验证失败会恢复原数据库。
卸载程序会询问是否同时删除本地数据。

### 首次初始化

仅全新环境使用：

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run setup
npm.cmd run build
```

桌面版首次启动不会运行 Seed，也不包含默认账号或密码。初始化向导依次为：数据位置、
激活 VERIDIA 账号、登录 VERIDIA、同步审核规则、登录小红书、完成。无法访问 GitHub
时直接使用安装包内置规则，不阻塞启动。
`npm run db:seed` 仅执行可重复的本地运行环境和内置规则初始化，不创建审核测试数据。

账号完全离线运行：开发者使用根目录的 `创建VERIDIA账号.bat` 生成紧凑的 Ed25519
签名激活码，用户在首次启动页验证激活码并自行设置本地登录密码。新版 `VRD2` 激活码
只包含账号授权信息，不包含明文密码或密码哈希；客户端使用 bcrypt 在本机生成密码哈希
并写入 SQLite，同时继续兼容既有 `VRD1` 激活码。登录后的随机会话令牌由 Electron
`safeStorage`（Windows DPAPI）加密保存，数据库只保存 SHA-256。账号创建、重置、续期
及纯离线限制见
[`docs/本地账号开发者说明.md`](docs/本地账号开发者说明.md)。

## 软件更新与规则更新

- 软件安装包继续从 `jd-pages/veridia` 的软件 Release 更新。
- 审核规则从另行创建的独立公开 GitHub 仓库匿名读取。
- 规则仓库地址保存在 `rules/config.json`，签名公钥保存在 `rules/public-key.pem`。
- 普通客户端不包含 GitHub Token、发布私钥或上传逻辑。
- 规则发布、签名、同步与回滚流程见 [`docs/GITHUB-RULES.md`](docs/GITHUB-RULES.md)。

## 常用验证命令

```powershell
npm.cmd run db:generate
npm.cmd run db:ensure
npm.cmd run db:deploy
npm.cmd run db:seed
npm.cmd run excel:template
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run build
```

笔记链接模板生成到 `templates/笔记导入模板.xlsx`；活动规则长期维护模板为
`templates/活动规则标准导入模板.xlsx`。

> `npm.cmd run db:seed` 不会删除已有数据，也不会创建审核任务、审核结果、人工复核、演示账号或 Mock 数据。

## 活动规则 Excel 导入

1. 在“活动与规则”页面点击“导入活动规则”。
2. 上传原始横向活动需求表或四工作表标准模板。
3. 先执行“预检查”。此步骤只读取工作簿、单元格、合并区域和嵌入图片位置，不写数据库。
4. 核对活动、产品、话题规则、缺失产品名、缺失段位、重复/不规范话题、原表嵌入产品图位置及新增/更新清单。
5. 只有点击“确认导入”后才写入标准化规则。

标准模板包含“活动基础规则、产品资料、话题规则、内容参考方向”四个工作表，
不使用复杂合并单元格，不依赖产品图片识别，也不要求填写虚构商品编码。

审核任务必须选择产品系列和“产品阶段话题”。运营端只显示原始 Excel 表头对应的
三个选项：`IFFO：P段/1段`、`IFFO：2段`、`GUM：3段/4段/1+段/2+段`；
内部唯一值分别为 `IFFO_P1`、`IFFO_2`、`GUM_3_4_1PLUS_2PLUS`。
系统只加载品牌通用话题、当前产品话题和当前产品阶段话题；所有指定话题均执行
文字精确匹配，并要求是真实蓝色可点击链接。

正文还会独立核验段位信息：`IFFO：P段/1段` 接受 P段、PRE、PRE段、1段中的
任意一个；`IFFO：2段` 要求 2段；`GUM：3段/4段/1+段/2+段` 接受
3段、4段、1+段、2+段中的任意一个。识别使用带边界的正则并优先匹配加号段位，
不会把 1+段、2+段拆成 1段、2段，也不会把话题标签中的段位当作正文段位。
对应阶段话题依次为 `#新生儿奶粉`、`#二段奶粉推荐`、`#三段奶粉推荐`。
有效正文字数会排除话题标签、链接、空格、换行和纯标点。

图片内容要求由客服人工检查，原表视觉说明只保存为“客服登记备注”。系统仅统计轮播图片数量，
不识别图片语义，也不调用视觉 AI。
公开留存分为“待验证、已满足、未满足”；达到复查日期后可从审核详情创建新的留存复查任务，
原历史结果和规则快照保持不变。奖励说明只保存为活动信息，不参与即时合规判断。

## 自动批量审核

### 首次登录小红书

1. 打开“审核任务”页面。
2. 点击“登录小红书”，桌面版会使用 `%LOCALAPPDATA%\VERIDIA\sessions\xiaohongshu-profile` 打开专用 Chromium。
3. 用户自行扫码、登录或完成平台要求的安全验证。
4. 回到后台点击“我已完成登录”。
5. 系统确认后把会话标记为“登录可用”，后续真实链接自动复用该用户目录。

系统不会自动填写账号、绕过验证码、规避登录限制或平台风控。

### 批量审核流程

1. 在默认的“自动批量审核”页选择产品、活动和产品阶段话题，批量粘贴链接；或在“Excel 自动审核”上传模板。
2. 系统创建 `AuditBatch` 和逐链接 `AuditTask`。
3. 本地单线程队列用 Playwright 逐条打开链接，根据独立 Adapter 提取页面证据。
4. 每条任务独立保存结果；一条失败不会中断后续链接。
5. 页面每秒更新总数、等待、处理、成功、失败、人工复核、当前链接和进度。
6. 批次可暂停、继续、取消和失败重试，完成后可导出 Excel。

`xhslink.com` 短链接会先跟随全部跳转，等待进入
`xiaohongshu.com/explore/...` 或 `xiaohongshu.com/discovery/item/...`
笔记详情页，再按最终地址选择提取 Adapter。任务会同时保存原始链接、最终链接、
页面标题、页面类型和跳转链。

真实页面默认间隔为 5 秒，可通过 `AUTOMATION_INTERVAL_MS` 调整。模拟页面为了测试会缩短间隔。

### 登录失效与安全验证

当 Adapter 识别到登录失效、验证码或安全验证时，当前链接和批次进入“登录失效”状态，队列暂停。点击“登录小红书”完成人工登录/验证，确认登录状态后再点击批次“继续”。

自动失败会分别记录页面不存在、笔记删除、无权限、登录失效、短链接跳转失败、加载超时、结构不匹配、安全验证、网络错误、正文或话题未识别。图片缺失或图片节点无法读取不会产生错误。技术读取异常的任务状态统一显示为“读取失败”，同时保留具体错误码；不会运行内容规则，也不会生成“审核不通过”结论。失败任务还会在 `.playwright/evidence` 保存截图，并在数据库中保存受限长度的 HTML 结构摘要。

## 浏览器插件人工补审

1. 启动本地系统并登录。
2. 在审核任务页找到自动审核失败或待人工复核的单条链接。
3. Chrome/Edge 打开扩展管理页，开启开发者模式。
4. 选择“加载已解压的扩展程序”，指向项目的 `extension` 目录。
5. 用户自行正常登录小红书，打开待审核笔记。
6. 插件默认连接 `http://localhost:3100`。点击“测试连接”，确认地址和提交令牌有效后，再提交当前页面。

插件是备用流程，只处理当前主动打开且可见的页面，用于自动失败后的补审、单条重新提取和人工证据；不包含高频抓取、验证码处理、批量登录、反检测或绕过访问限制功能。

插件提交接口为 `POST /api/extension/submit`，健康检查接口为
`GET /api/extension/health`。提交令牌优先从服务端环境变量
`EXTENSION_TOKEN` 读取，未配置时使用本地数据库中的秘密设置值；
接口响应和插件日志都不会返回或记录完整令牌。

### 真实页面选择器维护

自动 Playwright 与插件的真实小红书选择器分别集中在：

```text
lib/automation/adapters.ts
extension/src/adapters/xiaohongshu.js
```

只维护该文件的 `SELECTORS` 常量和对应适配器。模拟页面适配器在 `extension/src/adapters/mock.js`；审核引擎不依赖 DOM 选择器。

页面结构变化后，应在已登录浏览器中人工检查标题、正文、作者、发布时间和话题链接节点，再更新选择器并重新执行模拟/人工验证。不要尝试绕过平台登录或风控。

## 模拟页面

可直接在浏览器打开：

```text
http://localhost:3100/mock/xhs?case=passed
http://localhost:3100/mock/xhs?case=failed
http://localhost:3100/mock/xhs?case=few-images
http://localhost:3100/mock/xhs?case=empty-body
http://localhost:3100/mock/xhs?case=inaccurate-topic
http://localhost:3100/mock/xhs?case=unclickable-topic
http://localhost:3100/mock/xhs?case=read-failed
http://localhost:3100/mock/xhs?case=login-expired
http://localhost:3100/mock/xhs?case=deleted
http://localhost:3100/mock/xhs?case=no-permission
http://localhost:3100/mock/xhs?case=security-verification
http://localhost:3100/mock/xhs?case=structure-mismatch
http://localhost:3100/mock/xhs?case=few-images
http://localhost:3100/mock/xhs?case=no-images
http://localhost:3100/mock/xhs?case=video-note
```

后台 Seed 会为列表中的前 7 个基础案例生成任务和审核结果；其余状态案例供自动队列与失败分类测试使用。

## AI 依赖

桌面版 AI 状态固定为 `DISABLED`。设置页不显示 OpenAI 或 AI 登录入口，运行时不会读取
`OPENAI_API_KEY`、调用语义模型或视觉模型。历史表中的 AI 字段仅为数据库兼容保留。

## 图片数量审核

- 系统只识别图文/视频类型并统计图文笔记轮播中的去重图片数量，不执行图片内容识别。
- 支持 `img`、`picture/source`、`srcset`、懒加载属性和 CSS `background-image`，并排除头像、评论、推荐封面、图标及装饰图片。
- 图文笔记读取成功后按活动的“最低图片数量”确定性审核。
- 视频笔记保存为 `VIDEO_NOTE`，不按 0 张处理；页面正常但数量无法确认时保存为 `IMAGES_READ_FAILED` 并进入人工复核。
- 不调用视觉 AI，不判断产品实拍、首图、宝宝合照或平台导向，也不长期保存图片 URL。

## SQLite 与 PostgreSQL

本地事实来源是 `prisma/schema.prisma`。运行：

```powershell
npm.cmd run db:postgres-schema
```

会机械生成完整 PostgreSQL 版本 `prisma/schema.postgresql.prisma`。生产部署前设置 `POSTGRES_DATABASE_URL`，用该 schema 生成生产迁移，并在隔离环境验证索引与日期时区。

## 数据安全与已知限制

- 第一版一条任务选择一个主产品和一个活动；自动队列默认单线程，不提供高并发。
- 真实页面提取依赖平台 DOM，平台改版后需维护适配器选择器。
- 页面中的“蓝色”不是唯一依据；最终可点击判断同时要求可交互元素、有效跳转地址和话题样式特征。
- SQLite 适合单机内部演示和轻量使用；多人生产使用建议 PostgreSQL。
- 当前登录为纯本地签名账号体系，不含企业 SSO、在线密码找回和 MFA；支持本地短时登录限流、
  本机管理员重置普通账号密码及开发者签名密码重置码。
- 插件令牌是本地演示默认值；真实内部环境应改成高强度令牌并限制网络访问。
- 未集成真实小红书官方 API，也不会绕过登录、验证码、权限或平台风控。
- Excel 单文件限制 10MB；大批量任务建议分批导入。
- 历史图片 URL 字段继续保留兼容；新提取只保存去重后的数量和提取状态，不保存图片 URL。

## 主要目录

```text
app/                    Next.js 页面与 API
components/             后台通用界面组件
lib/audit-engine.ts     确定性审核引擎
lib/audit-service.ts    提取落库、规则快照与审核服务
lib/automation/         自动队列、持久化浏览器和 Playwright Adapter
lib/ai.ts               桌面版禁用状态兼容层
prisma/schema.prisma    SQLite 数据模型
prisma/migrations/      Prisma 初始迁移
prisma/seed.ts          可重复的本地运行环境与内置规则初始化（不写入测试审核数据）
extension/              Chrome/Edge Manifest V3 插件
templates/              Excel 导入模板
tests/unit/             Vitest 单元测试
tests/e2e/              Playwright 关键流程测试
scripts/                Windows 启动、数据库和模板脚本
desktop/                Electron 主进程、更新器与 NSIS 卸载逻辑
.github/workflows/       main 检查与版本发布流水线
```

## VERIDIA 固定发布流程

Codex 完成功能修改后不得直接发布，也不得直接上传安装包。软件更新固定分为以下
三个阶段，任何时候都不要跳过本地预览和本地打包验收：

1. 双击 `本地预览测试.bat`。脚本只启动最新源码供浏览器检查，不打包、不升版本，
   不创建 Tag 或 GitHub Release，也不上传任何文件。端口 3100 被占用时不会结束
   其他程序，可由用户确认改用 3101。脚本提供三种预览方式：
   - 安全预览（默认推荐）：使用 `E:\v-preview`，自动迁移、准备内置规则及
     `Terry Preview` 管理员，直接进入工作台，不需要激活或重新登录。
   - 正式数据预览：默认读取桌面端 `data-location` 配置中的当前正式数据目录，也可通过
     `VERIDIA_PRODUCTION_DATA_DIR` 显式覆盖；必须输入确认文字，迁移前自动备份数据库，
     不删除、清空或重置正式数据。
   - 首次启动流程测试：使用独立的新目录并保留正式 setup、VRD1/VRD2 激活和登录流程。

   免激活只在 `VERIDIA_LOCAL_PREVIEW=1`、源码开发服务器、非桌面打包且
   `NODE_ENV=development` 同时成立时有效。正式安装包、生产构建及普通启动不能使用
   该预览身份。
2. 页面和功能确认后双击 `本地打包验收.bat`。脚本依次运行 TypeScript、ESLint、
   单元测试、隔离数据库 E2E、Next.js 生产构建、敏感信息扫描和 Electron/NSIS
   Windows 打包。安装包只保存在 `release\<版本号>\` 和 `dist-installer\`，
   不创建 Tag、Release 或上传文件。安装、升级、登录、规则同步、审核和导出必须
   在本机验收通过。
3. 以上两步均通过后，最后双击 `发布新版.bat`，核对计划并输入 `Y`。这是正式软件发布
   和恢复的唯一用户入口。脚本统一审计 ReleaseState，在本地 FULL 与安装包校验通过后
   创建独立 Release Commit、Push main、等待 exact HEAD 的 Main CI，再创建并 Push Tag；
   GitHub Release Workflow 在 clean runner 独立完成 FULL、Package、Release 和远端校验。
   最终必须显示 `RELEASE = PASS`。

   如果网络或进程中断，仍然重新运行 `发布新版.bat`。发布器会依据持久化 Checkpoint、
   HEAD、版本、源码指纹、Tag、Actions 和 Release 状态自动恢复，不会重复 FULL、Build、
   Release Commit、Tag 或 Release 写操作。不要手工 Tag/Release，不要 reset、rebase、
   force push。只有幂等只读网络请求会在明确的临时网络错误时有限重试；发布写操作不重试。

   软件 Release 的 EXE、同名 `.exe.blockmap` 和 `latest.yml` 缺一不可。发布脚本会在
   本机和 GitHub Actions 中分别校验三件套，并在 Release 创建后再次核对远程文件大小、
   SHA-256/SHA-512 与匿名下载状态。客户端通过 Published Latest Release 的 `latest.yml`
   检测版本，并优先使用 blockmap
   进行差分更新；该流程不会执行 `rules:publish`。

   只有 Tag、没有 Published Release 的失败版本属于 `FAILED_RELEASE_TAG`，不会成为自动
   更新版本。远程 Tag 一旦 Push 即消费版本；Workflow 确定失败时保留 Tag，不移动、不删除、
   不补建 Release，修复后准备下一版本。

本地打包后的任何源码变化都会使验收记录失效，必须重新运行
`本地打包验收.bat`。普通代码保存、预览和测试不会触发正式发布。

规则更新与软件更新必须分开：

- `RULE_ONLY`：现有软件能力已能表达需求，仅修改产品、活动、阶段、月份、店铺话题、
  现有规则参数或已有能力支持的 alias。通过 `发布规则新版.bat` 发布，不升级 VERIDIA
  软件版本。
- `SOFTWARE_CHANGE`：新增程序能力、规则类型或匹配语义，或者修改 resolver、审核引擎、
  API、UI、Runner、Desktop、Schema、程序 Migration 或发布基础设施。通过
  `发布新版.bat` 发布，并升级 VERIDIA 软件版本。
- 当店铺改名只需更新正式名称、历史 alias 和店铺话题词，且现有 alias / matcher 已支持时，
  保持同一 shop identity，分类为 `RULE_ONLY`；只有现有程序能力无法表达新规则时才升级软件。
- `发布新版.bat` 不会发布规则；`发布规则新版.bat` 不会发布软件安装包。

底层 `npm run release:patch`、`release:minor` 和 `release:major` 只用于脚本内部的
本地版本准备与打包，不应绕过正式 BAT 入口单独执行。客户端启动后检查软件更新，发现新版
时由用户选择下载和重启安装。

代码签名通过 GitHub Secrets `WINDOWS_CSC_LINK` 和 `WINDOWS_CSC_KEY_PASSWORD`
提供，证书不进入仓库。未配置证书仍可生成内部测试包，但 Windows 可能显示“未知发布者”。

## 表格模板同步

审核任务支持本地 Excel、CSV 以及腾讯文档导出的 Excel/CSV 文件。字段别名、
必填列、导入列顺序、导出列顺序和示例模板由规则包中的
`importExportTemplates` 配置驱动；旧规则包缺少该配置时自动使用内置默认模板。
下载模板、导入预览和结果导出均在本机完成，不上传用户表格或审核数据。

腾讯文档在线链接读取、授权和回写目前只有接口预留，不包含在线 API、登录入口或
Token 存储。详细约束见
[`docs/表格模板与腾讯文档兼容说明.md`](docs/表格模板与腾讯文档兼容说明.md)。

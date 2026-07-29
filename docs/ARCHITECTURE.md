# 项目架构与数据设计

## 总体架构

```text
批量粘贴 / Excel 导入
          |
    自动审核批次 API
          |
  单线程持久化任务队列
          |
 Playwright persistent context
          |
  ExtractorAdapter（模拟 / 真实页面）
          |
      统一审核服务
          |
  Prisma ORM -> SQLite / PostgreSQL

Chrome Extension -> 人工补审 API -> 同一 ExtractedNote / 审核服务
```

默认入口是自动批量审核。系统为每次导入创建 `AuditBatch`，为每个链接创建独立
`AuditTask`，后台队列按顺序逐条执行。单条失败只更新该任务，队列继续处理后续链接。
暂停、继续、取消和失败重试都通过持久化状态控制，重启后可恢复未完成任务。

真实页面使用 Playwright persistent context 和独立用户目录 `.playwright/xhs-profile`。
首次使用由运营人员在专用浏览器手动登录；系统不绕过验证码、登录限制或平台风控。
登录失效或出现安全验证时批次暂停，重新登录后可以继续。

浏览器插件只读取用户主动打开且可见的页面，用于自动失败后的人工补审、单条重提取
和页面结构异常证据。插件、模拟页面和真实 Playwright 页面共用 `ExtractedNote`
数据结构；各自 DOM 选择器封装在独立 Adapter 中，审核引擎不依赖具体页面结构。

## 规则合并与版本

规则按全局、产品、活动三层合并。活动持有递增的 `ruleVersion`；规则增删改会生成
新版本。每次审核在 `audit_results` 保存版本号与完整规则快照，`rule_results`
保存逐项证据，因此修改规则不会改变历史审核结果。

## 主要数据表

- `audit_batches`：批次状态、总数、当前任务、进度和暂停/取消信息。
- `audit_tasks`：每条链接的队列顺序、状态、尝试次数和细分失败原因。
- `automation_sessions`：专用浏览器登录状态及用户目录位置，不保存密码。
- `users`：账号、角色和停用状态。
- `products` / `product_aliases`：产品主数据和别名。
- `campaigns`：活动、月份、规则版本和图片/可点击要求。
- `topic_rules`：全局、产品、活动三层话题规则。
- `note_records` / `note_topics`：标准化笔记内容与话题 DOM 证据。
- `extraction_records`：每次提取的原始快照。
- `audit_results` / `rule_results`：综合结果、规则快照与逐规则结论。
- `manual_reviews`：人工复核结论，不覆盖自动审核结果。
- `import_records`：Excel 预检与导入摘要。
- `operation_logs`：关键操作审计。
- `system_settings`：运行设置与 AI 开关，不保存完整 Key。

## 失败隔离

提取失败会被区分为页面不存在、笔记删除、无权限、登录失效、加载超时、页面结构
不匹配、安全验证、网络错误、未识别正文、未识别图片和未识别话题。登录失效和安全
验证会暂停批次；其他单条错误不会终止整个批次。

## 验证层次

1. TypeScript、ESLint 与单元测试。
2. API 和持久化队列端到端测试。
3. 多行 Excel 导入、失败隔离、暂停/继续、失败重试和结果导出。
4. 浏览器页面检查与 Chrome Extension 人工补审回归。
5. 生产构建和 Windows 本地启动验证。

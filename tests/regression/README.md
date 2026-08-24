# Protected Behavior Regression

这里保存已由生产现场、人工验收或正式业务规则确认的黄金行为及最小复现 fixture。

注册表位于 `scripts/testing/protected-behaviors.mjs`。每个行为都绑定业务不变量、Unit、E2E/fixture、精确 case title 和触发文件范围；汇总按 `spec path + case title` 逐行为计算，禁止用整个测试组的失败批量刷红无关行为。受保护期望只能在“正式业务规则确实改变且用户明确批准”后修改；普通功能开发若使其失败，按 regression 修复业务代码，禁止顺手改 expected value。

生产、人工验收或客户现场 Bug 修复时，必须新增或更新保留关键 DOM/数据条件的最小 fixture。只 mock 最终返回值不算现场复现。

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs
    .readFileSync(path.join(process.cwd(), relativePath), "utf8")
    .replace(/\r\n/gu, "\n");
}

describe("小红书持久会话与访问节奏", () => {
  it("登录、检测和审核复用唯一 persistent context 与固定 Profile", () => {
    const browser = source("lib/automation/browser.ts");
    const extract = source("lib/automation/extract.ts");
    const hiddenChromium = source(
      "lib/automation/windows-hidden-chromium.ts",
    );
    expect(browser.match(/launchPersistentContext\(/gu)).toHaveLength(1);
    expect(browser).not.toContain("browser.newContext(");
    expect(browser).not.toContain("loginContext");
    expect(browser).not.toContain("workerContext");
    expect(browser).toContain('"sessions",\n  "xiaohongshu-profile"');
    expect(browser).toContain("登录/验证完成后保留自动审核 Page，仅关闭独立人工登录 Page");
    expect(browser).toContain("profileLocked");
    expect(browser).toContain("profilePath: PROFILE_DIRECTORY");
    expect(browser).toContain("heartbeatXhsAuditLock");
    expect(browser).toContain("auditPage?: Page");
    expect(browser).toContain("auditPagePromise?: Promise<Page>");
    expect(hiddenChromium).toContain('"--no-startup-window"');
    expect(hiddenChromium).not.toContain("Target.createTarget");
    expect(hiddenChromium).not.toContain("hidden: true");
    expect(hiddenChromium).toContain("return context.newPage()");
    expect(hiddenChromium).toContain('"--remote-debugging-port=0"');
    expect(browser).not.toContain("PW_CHROMIUM_ATTACH_TO_OTHER");
    expect(source("playwright.config.ts")).not.toContain(
      "PW_CHROMIUM_ATTACH_TO_OTHER",
    );
    expect(source("desktop/main.cjs")).not.toContain(
      "PW_CHROMIUM_ATTACH_TO_OTHER",
    );
    expect(source("scripts/release.mjs")).not.toContain(
      "PW_CHROMIUM_ATTACH_TO_OTHER",
    );
    expect(browser).toContain("createAuditPage");
    expect(browser).toContain("getXhsAuditPage");
    expect(browser).toContain("auditPageCreateCount");
    expect(browser).toContain("auditPageReuseCount");
    expect(extract).toContain("getXhsAuditPage({ taskId: task.id, url: task.url })");
    expect(extract).not.toContain("context.newPage()");
    expect(extract).not.toContain("page.bringToFront()");
    expect(extract).not.toContain("await page.close()");
    expect(extract).toContain("auditPageKeptOpen");
  });

  it("仅人工登录或安全验证允许显示窗口，自动导航不聚焦或恢复", () => {
    const browser = source("lib/automation/browser.ts");
    const extract = source("lib/automation/extract.ts");
    const hiddenChromium = source(
      "lib/automation/windows-hidden-chromium.ts",
    );

    expect(browser.match(/\.bringToFront\(\)/gu)).toHaveLength(1);
    expect(browser).toContain("showXhsManualIntervention");
    expect(browser).toContain('reason: "LOGIN_REQUIRED" | "SECURITY_RESTRICTED" | "USER_REQUESTED"');
    expect(extract).toContain('showXhsManualIntervention(page, "LOGIN_REQUIRED")');
    expect(extract).toContain(
      'showXhsManualIntervention(page, "SECURITY_RESTRICTED")',
    );
    expect(extract).toContain("bringToFrontCalled: false");
    expect(extract).toContain("focusCalled: false");
    expect(extract).toContain("restoreCalled: false");
    expect(extract).not.toContain('goto("https://www.xiaohongshu.com/explore"');
    expect(hiddenChromium).not.toContain("SW_HIDE");
    expect(hiddenChromium).not.toContain("ShowWindow");
  });

  it("专用浏览器意外关闭时保留断点并按控制问题暂停", () => {
    const browser = source("lib/automation/browser.ts");
    const extract = source("lib/automation/extract.ts");
    const queue = source("lib/automation/queue.ts");

    expect(browser).toContain("contextClosedUnexpectedly");
    expect(browser).toContain("审核浏览器连接异常，当前批次已暂停");
    expect(extract).toContain('new AutomaticExtractionError(\n        "BROWSER_CONTROL_ERROR"');
    expect(queue).toContain('"BROWSER_CONTROL_ERROR"');
    expect(queue).toContain('status: "PENDING"');
  });

  it("安全限制保留断点，网络重试最多两次且队列保持单并发", () => {
    const queue = source("lib/automation/queue.ts");
    const pacing = source("lib/automation/pacing.ts");
    expect(queue).toContain('status: "PENDING"');
    expect(queue).toContain('"SECURITY_RESTRICTED"');
    expect(queue).toContain('failureCode: "SESSION_RESUME_REQUESTED"');
    expect(queue).toContain('pageStatus: { in: ["LOGIN_EXPIRED", "SECURITY_VERIFICATION"] }');
    expect(queue).toContain("waitWhileBatchRunning");
    expect(queue).toContain('"INTER_TASK_WAIT"');
    expect(queue).toContain('"RETRY_WAIT"');
    expect(queue).toContain('"COOLDOWN"');
    expect(queue).toContain("if (!nextTask)");
    expect(queue).toContain("keepProcessingOnlyWhileBatchRuns");
    expect(queue).toContain('["PENDING", "PROCESSING", "LOGIN_EXPIRED"]');
    expect(queue).toContain('where: { id: task.id, status: "PENDING" }');
    expect(queue).toContain('where: { id: batchId, status: "RUNNING" }');
    expect(queue).toContain("queueState.activeBatchId");
    expect(pacing).toContain("XHS_NETWORK_MAX_RETRIES: 2");
    expect(pacing).toContain("XHS_NETWORK_RETRY_FIRST_MS: 5_000");
    expect(pacing).toContain("XHS_NETWORK_RETRY_SECOND_MS: 15_000");
    expect(pacing).toContain("XHS_COOLDOWN_TASK_COUNT: 25");
    expect(pacing).toContain("concurrency: 1 as const");
  });

  it("浏览器控制故障按批次暂停且最多自动恢复一次", () => {
    const browser = source("lib/automation/browser.ts");
    const queue = source("lib/automation/queue.ts");
    const failure = source("lib/automation/failure.ts");
    const platformRuntime = source("lib/automation/platform-runtime.ts");

    expect(failure).toContain('"BROWSER_CONTROL_ERROR"');
    expect(failure).toContain("Target\\.createTarget");
    expect(browser).toContain("automaticRecoveryAttempt: recoveryAttempt");
    expect(browser).toContain("recoveryAttempt >= 1");
    expect(browser).toContain("controlState: state.controlState");
    expect(queue).toContain(
      'extractionError.code === "BROWSER_CONTROL_ERROR"',
    );
    expect(queue).toContain('status: browserControlIssue\n              ? "PAUSED"');
    expect(queue).toContain("await runtime.ensureBrowserReady()");
    expect(platformRuntime).toContain("ensureXhsBrowserControlReady(true)");
  });
});

describe("抖音独立持久会话与后台审核页", () => {
  it("使用独立 Profile、唯一 context 与长期复用 auditPage", () => {
    const browser = source("lib/automation/douyin-browser.ts");
    const extract = source("lib/automation/douyin-extract.ts");
    expect(browser.match(/launchPersistentContext\(/gu)).toHaveLength(1);
    expect(browser).toContain('"douyin-profile"');
    expect(browser).toContain("DOUYIN_PROFILE_PATH");
    expect(browser).toContain("auditPage?: Page");
    expect(browser).toContain("auditPagePromise?: Promise<Page>");
    expect(browser).toContain("createAuditPage(context)");
    expect(extract).toContain("getDouyinAuditPage({ taskId: task.id, url: task.url })");
    expect(extract).not.toContain("context.newPage()");
    expect(extract).not.toContain("page.bringToFront()");
    expect(extract).not.toContain("await page.close()");
  });

  it("只有人工交互入口聚焦，正常、异常和重试均复用后台页", () => {
    const browser = source("lib/automation/douyin-browser.ts");
    const extract = source("lib/automation/douyin-extract.ts");
    expect(browser.match(/\.bringToFront\(\)/gu)).toHaveLength(1);
    expect(browser).toContain("showDouyinManualIntervention");
    expect(extract).toContain('showDouyinManualIntervention(page, "LOGIN_REQUIRED")');
    expect(extract).toContain('showDouyinManualIntervention(page, "SECURITY_RESTRICTED")');
    expect(extract).not.toContain("bringToFront");
    expect(extract).not.toContain("newPage(");
    expect(browser).toContain('await setWindowState(interactivePage, "minimized")');
  });

  it("两个平台使用不同会话、锁和访问节奏，同时由单并发队列路由", () => {
    const runtime = source("lib/automation/platform-runtime.ts");
    const pacing = source("lib/automation/pacing.ts");
    const queue = source("lib/automation/queue.ts");
    expect(runtime).toContain("runtimeRegistry");
    expect(runtime).toContain('sessionId: "douyin"');
    expect(runtime).toContain('sessionId: "xiaohongshu"');
    expect(pacing).toContain("DOUYIN_NETWORK_MAX_RETRIES: 2");
    expect(pacing).toContain("DOUYIN_AUDIT_WAIT_MIN_MS: 7_000");
    expect(queue).toContain("automationRuntime(platform)");
    expect(queue).toContain("queueState.activeBatchId");
    expect(queue).toContain('status: { in: ["PAUSED", "LOGIN_EXPIRED", "SECURITY_RESTRICTED"] }');
    expect(queue).toContain('orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }]');
    expect(source("lib/automation/browser.ts")).toContain('platform: "XIAOHONGSHU"');
    expect(source("lib/automation/douyin-browser.ts")).toContain('platform: "DOUYIN"');
  });

  it("混合 Excel 共用一个导入记录并按平台拆分为串行子批次", () => {
    const route = source("app/api/import/notes/route.ts");
    const batchService = source("lib/automation/batch-service.ts");
    expect(route).toContain('["XIAOHONGSHU", "DOUYIN"] as const');
    expect(route).toContain("const channelTasks = tasks.filter");
    expect(route).toContain("importRecordId: importRecord.id");
    expect(route).toContain("allowQueuedBehindActive: true");
    expect(route).toContain("batchIds = committed.batches.map");
    expect(route).toContain("channelDistribution: JSON.stringify(channelDistribution)");
    expect(batchService).toContain("platforms.length !== 1");
    expect(batchService).toContain("queueOrder: Math.max(0, input.queueOrder || 0)");
  });
});

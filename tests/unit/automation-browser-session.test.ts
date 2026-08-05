import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
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
    expect(hiddenChromium).toContain('hidden: true');
    expect(hiddenChromium).toContain('background: true');
    expect(hiddenChromium).toContain('focus: false');
    expect(hiddenChromium).toContain('"--remote-debugging-port=0"');
    expect(browser).toContain('process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1"');
    expect(source("playwright.config.ts")).toContain(
      'PW_CHROMIUM_ATTACH_TO_OTHER: "1"',
    );
    expect(source("desktop/main.cjs")).toContain(
      'PW_CHROMIUM_ATTACH_TO_OTHER: "1"',
    );
    expect(source("scripts/release.mjs")).toContain(
      'PW_CHROMIUM_ATTACH_TO_OTHER: "1"',
    );
    expect(browser).toContain("createHiddenAuditPage");
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

  it("专用浏览器意外关闭时保留断点并按登录问题暂停", () => {
    const browser = source("lib/automation/browser.ts");
    const extract = source("lib/automation/extract.ts");
    const queue = source("lib/automation/queue.ts");

    expect(browser).toContain("contextClosedUnexpectedly");
    expect(browser).toContain("小红书专用浏览器已关闭，审核任务已暂停");
    expect(extract).toContain('new AutomaticExtractionError(\n        "LOGIN_REQUIRED"');
    expect(queue).toContain('"LOGIN_REQUIRED"');
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
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("小红书持久会话与访问节奏", () => {
  it("登录、检测和审核复用唯一 persistent context 与固定 Profile", () => {
    const browser = source("lib/automation/browser.ts");
    expect(browser.match(/launchPersistentContext\(/gu)).toHaveLength(1);
    expect(browser).not.toContain("browser.newContext(");
    expect(browser).not.toContain("loginContext");
    expect(browser).not.toContain("workerContext");
    expect(browser).toContain('"sessions",\n  "xiaohongshu-profile"');
    expect(browser).toContain("只关闭登录 Page，不关闭 persistent context");
    expect(browser).toContain("profileLocked");
    expect(browser).toContain("profilePath: PROFILE_DIRECTORY");
    expect(browser).toContain("heartbeatXhsAuditLock");
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

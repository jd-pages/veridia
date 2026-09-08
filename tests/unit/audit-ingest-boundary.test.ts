import { PrismaClient, type AuditTask } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditIngestFixture, auditIngestExtraction } from "../helpers/audit-ingest-fixture";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

const isolated = vi.hoisted(() => ({
  db: undefined as PrismaClient | undefined,
  userId: "",
  beforeTransaction: undefined as (() => Promise<void>) | undefined,
}));
// Only the DB binding and request identity are injected. All service logic,
// delegates, transactions, extraction validation and API handlers remain real.
vi.mock("@/lib/db", () => ({ get prisma() { return isolated.db; } }));
vi.mock("@/lib/auth", () => ({
  getSession: async () => ({ id: isolated.userId, username: "ingest-admin", displayName: "入口管理员", role: "ADMIN" }),
}));

import { runAuditTask } from "@/lib/audit-service";
import { POST as auditPost } from "@/app/api/tasks/[id]/audit/route";
import { POST as extensionPost } from "@/app/api/extension/submit/route";

let temporaryRoot: string;
let db: PrismaClient;
let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>>;
const extensionToken = "isolated-ingest-token";

async function counts() {
  return Promise.all([db.auditResult.count(), db.extractionRecord.count(), db.noteRecord.count()]);
}
async function post(task: AuditTask, body: unknown) {
  return auditPost(new Request(`http://localhost/api/tasks/${task.id}/audit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: task.id }) });
}
async function unchanged(task: AuditTask, previous: number[]) {
  expect(await counts()).toEqual(previous);
  expect(await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: task.status });
}

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-audit-ingest-"));
  const databasePath = path.join(temporaryRoot, "isolated.db");
  fs.writeFileSync(databasePath, "");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  try {
    execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", path.resolve("prisma/schema.prisma")], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe", windowsHide: true, timeout: 120_000,
    });
  } catch (error) {
    const output = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`隔离数据库 migration 失败：${output.stdout?.toString() || ""}\n${output.stderr?.toString() || ""}`, { cause: error });
  }
  db = new PrismaClient({ datasourceUrl: databaseUrl });
  isolated.db = new Proxy(db, { get(target, property) {
    if (property === "$transaction") return async (...args: unknown[]) => {
      const before = isolated.beforeTransaction;
      isolated.beforeTransaction = undefined;
      await before?.();
      return Reflect.apply(target.$transaction, target, args);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const user = await db.user.create({ data: { username: "ingest-admin", displayName: "入口管理员", passwordHash: "unused-fixture", role: "ADMIN" } });
  isolated.userId = user.id;
  fixture = await createAuditIngestFixture(db);
}, 120_000);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERIDIA_E2E", "false");
  vi.stubEnv("EXTENSION_TOKEN", extensionToken);
});
afterEach(() => {
  isolated.beforeTransaction = undefined;
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db?.$disconnect();
  isolated.db = undefined;
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("veridia-audit-ingest-")) throw new Error("拒绝清理非测试临时目录");
    await removeTemporaryDirectoryWithRetry(resolved);
  }
});

describe("审核提交边界：真实 Prisma 与 API", () => {
  it("Protected AUDIT_INGEST_NO_MOCK_AND_STATE_LEASE：production 缺少 extraction 与显式 mock 均不产生结果", async () => {
    const task = await fixture.task();
    const previous = await counts();
    for (const body of [{}, { mockCase: "passed" }, { other: "missing extraction" }]) {
      const response = await post(task, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false, errorDetail: { code: "EXTRACTION_REQUIRED" } });
      await unchanged(task, previous);
    }
  });

  it("production 错误 JSON 和不完整 extraction 不写入", async () => {
    const task = await fixture.task();
    const previous = await counts();
    const malformed = await auditPost(new Request("http://localhost/api/audit", { method: "POST", body: "{" }), { params: Promise.resolve({ id: task.id }) });
    expect(malformed.status).toBe(400);
    expect((await post(task, { extraction: { url: task.url, topics: [] } })).status).toBe(400);
    await unchanged(task, previous);
  });

  it("production 服务层也拒绝 mock adapter", async () => {
    const task = await fixture.task();
    const previous = await counts();
    await expect(runAuditTask(task.id, auditIngestExtraction(task, { adapterName: "mock-xhs" }), { source: "MANUAL" })).rejects.toMatchObject({ code: "MOCK_EXTRACTION_DISABLED" });
    await unchanged(task, previous);
  });

  it("E2E 仍需显式合法 mockCase，不能默认 passed", async () => {
    vi.stubEnv("VERIDIA_E2E", "true");
    const url = `http://localhost:3100/mock/xhs?ingest=${Date.now()}`;
    const task = await fixture.task({ url, normalizedUrl: url });
    const previous = await counts();
    for (const body of [{}, { mockCase: "unknown" }]) {
      expect((await post(task, body)).status).toBe(400);
      await unchanged(task, previous);
    }
    const response = await post(task, { mockCase: "passed" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { autoStatus: "PASSED" } });
    expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(1);
  });

  it.each(["PROCESSING", "PAUSED", "CANCELLED", "COMPLETED"])("%s 任务拒绝人工和插件迟到提交且没有旁路写入", async (status) => {
    const task = await fixture.task({ status });
    const extraction = auditIngestExtraction(task);
    const previous = await counts();
    expect((await post(task, { extraction })).status).toBe(409);
    const response = await extensionPost(new Request("http://localhost/api/extension/submit", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Extension-Token": extensionToken },
      body: JSON.stringify({ taskId: task.id, extraction }),
    }));
    expect(response.status).toBe(409);
    await unchanged(task, previous);
  });

  it.each(["PENDING", "READ_FAILED", "FAILED", "NEEDS_REVIEW", "LOGIN_EXPIRED"])("无结果且独立的 %s 任务接受明确 MANUAL / EXTENSION 来源", async (status) => {
    for (const source of ["MANUAL", "EXTENSION"] as const) {
      const task = await fixture.task({ status });
      const result = await runAuditTask(task.id, auditIngestExtraction(task), { source });
      expect(result.autoStatus).toBe("PASSED");
      expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(1);
      expect(await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "COMPLETED" });
    }
  });

  it("插件 token 路径接受合法独立任务并禁止无凭证提交", async () => {
    const task = await fixture.task();
    const extraction = auditIngestExtraction(task);
    const body = JSON.stringify({ taskId: task.id, extraction });
    expect((await extensionPost(new Request("http://localhost/api/extension/submit", { method: "POST", body }))).status).toBe(401);
    expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(0);
    const response = await extensionPost(new Request("http://localhost/api/extension/submit", {
      method: "POST", headers: { "X-Extension-Token": extensionToken }, body,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { autoStatus: "PASSED" } });
  });

  it("活动批次任务不能通过省略 lease 走人工或插件路径", async () => {
    const batch = await db.auditBatch.create({ data: { status: "QUEUED", totalCount: 1 } });
    const task = await fixture.task({ batchId: batch.id });
    const previous = await counts();
    await expect(runAuditTask(task.id, auditIngestExtraction(task), { source: "EXTENSION" })).rejects.toMatchObject({ code: "TASK_SUBMISSION_NOT_ALLOWED" });
    await unchanged(task, previous);
  });

  it("已有结果的失败任务必须新建重审任务，不能重复回写", async () => {
    const task = await fixture.task();
    await runAuditTask(task.id, auditIngestExtraction(task, { pageStatus: "READ_FAILED", body: null, topics: [], verifiedPlatformTopics: [] }), { source: "MANUAL" });
    const before = await db.auditTask.findUniqueOrThrow({ where: { id: task.id } });
    const previous = await counts();
    await expect(runAuditTask(task.id, auditIngestExtraction(before), { source: "MANUAL" })).rejects.toMatchObject({ code: "STALE_AUDIT_SUBMISSION" });
    await unchanged(before, previous);
  });

  it("预检后取消任务仍由事务门禁拒绝，不能创建任何采集或结果", async () => {
    const task = await fixture.task();
    const previous = await counts();
    isolated.beforeTransaction = async () => { await db.auditTask.update({ where: { id: task.id }, data: { status: "CANCELLED" } }); };
    await expect(runAuditTask(task.id, auditIngestExtraction(task), { source: "MANUAL" })).rejects.toMatchObject({ code: "STALE_AUDIT_SUBMISSION" });
    expect(await counts()).toEqual(previous);
    expect(await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "CANCELLED" });
  });

  it("Runner 过期 runEpoch 和 claimEpoch 均拒绝，当前 lease 正常完成", async () => {
    const batch = await db.auditBatch.create({ data: { status: "RUNNING", runEpoch: 5, totalCount: 1 } });
    const task = await fixture.task({ batchId: batch.id, status: "PROCESSING", claimEpoch: 7 });
    await db.auditBatch.update({ where: { id: batch.id }, data: { currentTaskId: task.id } });
    const lease = { batchId: batch.id, taskId: task.id, runEpoch: 5, claimEpoch: 7 };
    const previous = await counts();
    for (const stale of [{ ...lease, runEpoch: 4 }, { ...lease, claimEpoch: 6 }]) {
      await expect(runAuditTask(task.id, auditIngestExtraction(task), { source: "RUNNER", executionLease: stale })).rejects.toMatchObject({ code: "STALE_RUNNER_COMPLETION" });
      await unchanged(task, previous);
    }
    expect((await runAuditTask(task.id, auditIngestExtraction(task), { source: "RUNNER", executionLease: lease })).autoStatus).toBe("PASSED");
  });

  it("明确矛盾的作品 ID、平台和最终 URL 均拒绝", async () => {
    const task = await fixture.task();
    const previous = await counts();
    const otherId = "ffffffffffffffffffffffff";
    for (const patch of [
      { noteId: otherId }, { platformNoteId: otherId }, { contentId: otherId },
      { finalUrl: `https://www.xiaohongshu.com/explore/${otherId}` },
      { contentChannel: "DOUYIN" as const },
      { url: "https://www.douyin.com/note/123456789" },
    ]) {
      const response = await post(task, { extraction: auditIngestExtraction(task, patch) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ errorDetail: { code: "CONTENT_IDENTITY_MISMATCH" } });
      await unchanged(task, previous);
    }
  });

  it("短链绑定已知 finalUrl，跟踪参数差异不误拒绝，冲突长 ID 仍拒绝", async () => {
    const finalUrl = "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa";
    const url = "https://xhslink.com/a/isolated-boundary";
    const task = await fixture.task({ url, normalizedUrl: url, finalUrl });
    const previous = await counts();
    await expect(runAuditTask(task.id, auditIngestExtraction(task, { noteId: "bbbbbbbbbbbbbbbbbbbbbbbb" }), { source: "EXTENSION" })).rejects.toMatchObject({ code: "CONTENT_IDENTITY_MISMATCH" });
    await unchanged(task, previous);
    expect((await runAuditTask(task.id, auditIngestExtraction(task, { url: `${finalUrl}?xsec_token=synthetic`, finalUrl }), { source: "EXTENSION" })).autoStatus).toBe("PASSED");
  });

  it("未知目的地短链必须有原始 URL 绑定", async () => {
    const url = "https://xhslink.com/a/isolated-unknown-destination";
    const task = await fixture.task({ url, normalizedUrl: url });
    const previous = await counts();
    await expect(runAuditTask(task.id, auditIngestExtraction(task, { url: "https://xhslink.com/a/another-link", finalUrl: null }), { source: "MANUAL" })).rejects.toMatchObject({ code: "CONTENT_IDENTITY_MISMATCH" });
    await unchanged(task, previous);
    expect((await runAuditTask(task.id, auditIngestExtraction(task), { source: "MANUAL" })).autoStatus).toBe("PASSED");
  });

  it("新任务拒绝任务创建前的旧 extraction", async () => {
    const task = await fixture.task();
    const previous = await counts();
    await expect(runAuditTask(task.id, auditIngestExtraction(task, { extractedAt: new Date(task.createdAt.getTime() - 60_000).toISOString() }), { source: "MANUAL" })).rejects.toMatchObject({ code: "STALE_EXTRACTION" });
    await unchanged(task, previous);
  });
});

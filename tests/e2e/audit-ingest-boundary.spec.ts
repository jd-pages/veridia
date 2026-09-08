import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { auditIngestExtraction, createAuditIngestFixture } from "../helpers/audit-ingest-fixture";
import { E2E_ORIGIN } from "./e2e-origin";

let db: PrismaClient;
let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>>;

test.beforeAll(async () => {
  const databaseUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("本测试只能通过隔离 E2E runner 执行，必须提供 E2E_DATABASE_URL");
  db = new PrismaClient({ datasourceUrl: databaseUrl });
  fixture = await createAuditIngestFixture(db);
});
test.afterAll(async () => {
  try { await fixture?.cleanup(); } finally { await db?.$disconnect(); }
});
test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } });
  expect(response.ok()).toBeTruthy();
});

test("Protected AUDIT_INGEST_NO_MOCK_AND_STATE_LEASE：空输入拒绝且仅显式 E2E mock 生成结果", async ({ page }) => {
  const url = `${E2E_ORIGIN}/mock/xhs?ingest-boundary=${Date.now()}`;
  const task = await fixture.task({ url, normalizedUrl: url });
  for (const body of [{}, { mockCase: "not-a-case" }]) {
    const response = await page.request.post(`/api/tasks/${task.id}/audit`, { data: body });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, errorDetail: { code: "EXTRACTION_REQUIRED" } });
    expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(0);
    expect(await db.extractionRecord.count({ where: { auditTaskId: task.id } })).toBe(0);
    expect(await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "PENDING" });
  }
  const response = await page.request.post(`/api/tasks/${task.id}/audit`, { data: { mockCase: "passed" } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, data: { autoStatus: "PASSED" } });
  expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(1);
});

test("CANCELLED 任务拒绝真实人工和插件提交且保持取消状态", async ({ page }) => {
  const task = await fixture.task({ status: "CANCELLED" });
  const extraction = auditIngestExtraction(task);
  const manual = await page.request.post(`/api/tasks/${task.id}/audit`, { data: { extraction } });
  expect(manual.status()).toBe(409);
  expect(await manual.json()).toMatchObject({ success: false, errorDetail: { code: "TASK_SUBMISSION_NOT_ALLOWED" } });
  const extension = await page.request.post("/api/extension/submit", {
    headers: { "X-Extension-Token": process.env.EXTENSION_TOKEN || "local-extension-demo-token" },
    data: { taskId: task.id, extraction },
  });
  expect(extension.status()).toBe(409);
  expect(await extension.json()).toMatchObject({ success: false, code: "TASK_SUBMISSION_NOT_ALLOWED" });
  expect(await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "CANCELLED" });
  expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(0);
  expect(await db.extractionRecord.count({ where: { auditTaskId: task.id } })).toBe(0);
});

test("错误作品身份拒绝，合法 manual 与 extension 各自完成独立任务", async ({ page }) => {
  const manualTask = await fixture.task();
  const wrong = await page.request.post(`/api/tasks/${manualTask.id}/audit`, {
    data: { extraction: auditIngestExtraction(manualTask, { contentId: "ffffffffffffffffffffffff" }) },
  });
  expect(wrong.status()).toBe(400);
  expect(await wrong.json()).toMatchObject({ errorDetail: { code: "CONTENT_IDENTITY_MISMATCH" } });
  expect(await db.auditResult.count({ where: { auditTaskId: manualTask.id } })).toBe(0);
  const valid = await page.request.post(`/api/tasks/${manualTask.id}/audit`, { data: { extraction: auditIngestExtraction(manualTask) } });
  expect(valid.status()).toBe(200);
  expect(await valid.json()).toMatchObject({ data: { autoStatus: "PASSED" } });
  const extensionTask = await fixture.task({ status: "READ_FAILED" });
  const extension = await page.request.post("/api/extension/submit", {
    headers: { "X-Extension-Token": process.env.EXTENSION_TOKEN || "local-extension-demo-token" },
    data: { taskId: extensionTask.id, extraction: auditIngestExtraction(extensionTask) },
  });
  expect(extension.status()).toBe(200);
  expect(await extension.json()).toMatchObject({ success: true, data: { autoStatus: "PASSED" } });
  for (const task of [manualTask, extensionTask]) {
    expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(1);
    expect(await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "COMPLETED" });
  }
});

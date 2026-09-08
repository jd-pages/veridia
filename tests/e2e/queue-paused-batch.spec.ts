import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/db";
import { lockValidExecutionLease, StaleRunnerCompletionError } from "@/lib/automation/execution-lease";
import { E2E_ORIGIN } from "./e2e-origin";

type Platform = "XIAOHONGSHU" | "DOUYIN";
const batchIds: string[] = [];
test.setTimeout(90000);

test.beforeEach(async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();
});

test.afterEach(async ({ page }) => {
  for (const id of batchIds.splice(0).reverse()) {
    const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id } });
    if (!["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"].includes(batch.status)) {
      expect((await page.request.post(`/api/automation/batches/${id}/control`, {
        data: { action: "CANCEL" },
      })).ok()).toBeTruthy();
    }
    expect((await page.request.post(`/api/automation/batches/${id}/clear`)).ok()).toBeTruthy();
  }
});

async function createBatch(page: Page, platform: Platform, delayed = false) {
  const product = await prisma.product.findFirstOrThrow({
    where: { name: { contains: "澳洲白金版" }, status: "ACTIVE" },
  });
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { contentChannel: platform, status: "ACTIVE", OR: [
      { productId: product.id }, { products: { some: { productId: product.id } } },
    ] },
  });
  const mock = platform === "DOUYIN" ? "douyin?case=video" : "xhs?case=passed";
  const response = await page.request.post("/api/automation/batches", {
    data: {
      name: `A07 ${platform} ${Date.now()}`, productId: product.id,
      campaignId: campaign.id, contentChannel: platform,
      productStage: platform === "DOUYIN" ? "IFFO_P1" : "IFFO_2",
      urls: `${E2E_ORIGIN}/mock/${mock}&autoDelay=${delayed ? 12000 : 0}&a07=${crypto.randomUUID()}`,
    },
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  const id = payload.data.batchId as string;
  batchIds.push(id);
  return id;
}

async function control(page: Page, id: string, action: "PAUSE" | "CONTINUE" | "CANCEL") {
  expect((await page.request.post(`/api/automation/batches/${id}/control`, {
    data: { action },
  })).ok()).toBeTruthy();
}

async function pauseRunningA(page: Page) {
  const id = await createBatch(page, "XIAOHONGSHU", true);
  await expect.poll(async () => {
    const response = await page.request.get("/api/automation/session?platform=XIAOHONGSHU");
    expect(response.ok()).toBeTruthy();
    return (await response.json()).data.generationLifecycle.activeExtractionCount;
  }, { timeout: 30000 }).toBe(1);
  const task = await prisma.auditTask.findFirstOrThrow({ where: { batchId: id, status: "PROCESSING" } });
  const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id } });
  const lease = { batchId: id, taskId: task.id, runEpoch: batch.runEpoch, claimEpoch: task.claimEpoch! };
  await control(page, id, "PAUSE");
  const paused = await prisma.auditBatch.findUniqueOrThrow({ where: { id } });
  expect(paused).toMatchObject({ status: "PAUSED", currentTaskId: null });
  expect(await prisma.auditTask.count({ where: { batchId: id, status: "PROCESSING" } })).toBe(0);
  await expect(prisma.$transaction((tx) => lockValidExecutionLease(tx, lease)))
    .rejects.toBeInstanceOf(StaleRunnerCompletionError);
  return { id, attempts: task.attempts, epoch: paused.runEpoch };
}

async function assertInactiveA(a: Awaited<ReturnType<typeof pauseRunningA>>, status = "PAUSED") {
  const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id: a.id }, include: { tasks: true } });
  expect(batch).toMatchObject({ status, currentTaskId: null });
  if (status === "PAUSED") expect(batch.runEpoch).toBe(a.epoch);
  expect(batch.tasks[0].attempts).toBe(a.attempts);
  expect(batch.tasks.some((task) => task.status === "PROCESSING")).toBe(false);
  expect(await prisma.auditResult.count({ where: { task: { batchId: a.id } } })).toBe(0);
}

async function complete(ids: string[], inactiveA?: Awaited<ReturnType<typeof pauseRunningA>>, status = "PAUSED") {
  await expect.poll(async () => {
    if (inactiveA) await assertInactiveA(inactiveA, status);
    expect(await prisma.auditTask.count({ where: { batchId: { in: batchIds }, status: "PROCESSING" } })).toBeLessThanOrEqual(1);
    return prisma.auditBatch.count({ where: { id: { in: ids }, status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] } } });
  }, { timeout: 45000, intervals: [100, 200, 500] }).toBe(ids.length);
  for (const id of ids) {
    const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id }, include: { tasks: { include: { auditResults: true } } } });
    expect(batch.startedAt).not.toBeNull();
    expect(batch.currentTaskId).toBeNull();
    expect(batch.tasks[0].status).toBe("COMPLETED");
    expect(batch.tasks[0].auditResults).toHaveLength(1);
    expect(batch.tasks[0].claimEpoch).toBeNull();
  }
  expect(await prisma.auditTask.count({ where: { batchId: { in: batchIds }, status: "PROCESSING" } })).toBe(0);
}

for (const platform of ["XIAOHONGSHU", "DOUYIN"] as const) {
  test(`A07 PAUSED A 不阻塞 ${platform} B 调度和完整完成`, async ({ page }, testInfo) => {
    const a = await pauseRunningA(page);
    const b = await createBatch(page, platform);
    const initial = await prisma.auditBatch.findUniqueOrThrow({ where: { id: b } });
    await testInfo.attach("B-after-create", { body: JSON.stringify({ id: b, status: initial.status, startedAt: initial.startedAt }), contentType: "application/json" });
    // One explicit wake; subsequent observations use Prisma and do not retry the scheduler.
    expect((await page.request.get(`/api/automation/batches?batchId=${b}`)).ok()).toBeTruthy();
    await complete([b], a);
    expect((await prisma.auditTask.findFirstOrThrow({ where: { batchId: b } })).attempts).toBe(1);
    await assertInactiveA(a);
  });
}

test("A07 Continue A 与已创建 B 串行完成且无重复 runner", async ({ page }) => {
  const a = await pauseRunningA(page);
  const b = await createBatch(page, "XIAOHONGSHU");
  for (let i = 0; i < 3; i += 1) await control(page, a.id, "CONTINUE");
  await complete([a.id, b]);
  expect((await prisma.auditTask.findFirstOrThrow({ where: { batchId: a.id } })).attempts).toBe(a.attempts + 1);
  expect((await prisma.auditTask.findFirstOrThrow({ where: { batchId: b } })).attempts).toBe(1);
});

test("A07 Cancel PAUSED A 后 B 正常完成且 A 不再执行", async ({ page }) => {
  const a = await pauseRunningA(page);
  const b = await createBatch(page, "XIAOHONGSHU", true);
  await expect.poll(async () => {
    const response = await page.request.get("/api/automation/session?platform=XIAOHONGSHU");
    return (await response.json()).data.auditLock?.batchId;
  }, { timeout: 30000 }).toBe(b);
  const before = (await (await page.request.get("/api/automation/session?platform=XIAOHONGSHU")).json()).data;
  const runningB = await prisma.auditBatch.findUniqueOrThrow({ where: { id: b } });
  const blockedCreate = await page.request.post("/api/automation/batches", { data: {
    productId: runningB.productId, campaignId: runningB.campaignId, productStage: runningB.productStage,
    urls: `${E2E_ORIGIN}/mock/xhs?case=passed&a07-blocked=${crypto.randomUUID()}`,
  } });
  expect(blockedCreate.status()).toBe(409);
  expect((await blockedCreate.json()).errorDetail.code).toBe("AUTOMATION_ALREADY_RUNNING");
  for (const action of ["PAUSE", "CANCEL"] as const) {
    await control(page, a.id, action);
    const after = (await (await page.request.get("/api/automation/session?platform=XIAOHONGSHU")).json()).data;
    expect(after.auditLock).toMatchObject({ batchId: b, taskId: before.auditLock.taskId });
    expect(after.activeBrowserOwnerGeneration).toBe(before.activeBrowserOwnerGeneration);
    expect(after.generationLifecycle.effectiveRunnerCount).toBe(1);
  }
  expect((await page.request.get(`/api/automation/batches?batchId=${b}`)).ok()).toBeTruthy();
  await complete([b], a, "CANCELLED");
  await assertInactiveA(a, "CANCELLED");
});

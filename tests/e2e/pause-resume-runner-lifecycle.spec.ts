import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/db";
import { recoverInterruptedAutomaticBatches } from "@/lib/automation/batch-execution-reconcile";
import {
  lockValidExecutionLease,
  StaleRunnerCompletionError,
} from "@/lib/automation/execution-lease";
import { E2E_ORIGIN } from "./e2e-origin";

const cleanupBatchIds: string[] = [];

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function auditScope() {
  const product = await prisma.product.findFirstOrThrow({
    where: { name: { contains: "澳洲白金版" }, status: "ACTIVE" },
  });
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: {
      contentChannel: "XIAOHONGSHU",
      status: "ACTIVE",
      OR: [
        { productId: product.id },
        { products: { some: { productId: product.id } } },
      ],
    },
  });
  return { product, campaign };
}

async function waitForBatchTerminal(batchId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let peakProcessing = 0;
  while (Date.now() < deadline) {
    const [batch, processing] = await Promise.all([
      prisma.auditBatch.findUniqueOrThrow({ where: { id: batchId } }),
      prisma.auditTask.count({ where: { batchId, status: "PROCESSING" } }),
    ]);
    peakProcessing = Math.max(peakProcessing, processing);
    expect(processing).toBeLessThanOrEqual(1);
    if (["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(batch.status)) {
      return { batch, peakProcessing };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待自动审核批次结束超时：${batchId}`);
}

test.afterEach(async ({ page }) => {
  for (const batchId of [...new Set(cleanupBatchIds)].reverse()) {
    const batch = await prisma.auditBatch.findUnique({
      where: { id: batchId },
      select: { status: true, clearedAt: true },
    });
    if (!batch || batch.clearedAt) continue;
    if (!["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"].includes(batch.status)) {
      await page.request
        .post(`/api/automation/batches/${batchId}/control`, {
          data: { action: "CANCEL" },
        })
        .catch(() => undefined);
    }
    await page.request
      .post(`/api/automation/batches/${batchId}/clear`)
      .catch(() => undefined);
  }
  cleanupBatchIds.length = 0;
});

test("真实 1.1.12 双 orphan fixture 可在 Startup Recovery 后按原顺序完成 100+ Task", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  const { product, campaign } = await auditScope();
  const suffix = Date.now();
  const tasks = Array.from({ length: 101 }, (_item, queueOrder) => {
    const scenario =
      queueOrder === 50
        ? "passed&simulate=load-timeout&retryCase=passed"
        : "passed";
    const url = `${E2E_ORIGIN}/mock/xhs?case=${scenario}&runner-fixture=${suffix}-${queueOrder}`;
    const processing = [2, 3].includes(queueOrder);
    const completed = queueOrder < 2 || (queueOrder >= 4 && queueOrder <= 22);
    return {
      url,
      normalizedUrl: url,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      source: "AUTOMATIC",
      platform: "XIAOHONGSHU",
      channel: "XIAOHONGSHU",
      queueOrder,
      status: processing ? "PROCESSING" : completed ? "COMPLETED" : "PENDING",
      attempts: processing ? 1 : 0,
      claimEpoch: null,
      startedAt: processing ? new Date() : null,
      finishedAt: completed ? new Date() : null,
    };
  });
  const currentBatch = await prisma.auditBatch.create({
    data: {
      name: `真实双 orphan fixture ${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      source: "AUTOMATIC",
      channel: "XIAOHONGSHU",
      status: "RUNNING",
      runEpoch: 0,
      totalCount: tasks.length,
      currentTaskId: null,
      tasks: { create: tasks },
    },
  });
  cleanupBatchIds.push(currentBatch.id);

  const historicalBatch = await prisma.auditBatch.create({
    data: {
      name: `历史 terminal orphan ${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      source: "AUTOMATIC",
      channel: "XIAOHONGSHU",
      status: "COMPLETED",
      totalCount: 1,
      finishedAt: new Date(),
      tasks: {
        create: {
          url: `${E2E_ORIGIN}/mock/xhs?case=passed&historical-orphan=${suffix}`,
          normalizedUrl: `${E2E_ORIGIN}/mock/xhs?case=passed&historical-orphan=${suffix}`,
          productId: product.id,
          campaignId: campaign.id,
          productStage: "IFFO_2",
          source: "AUTOMATIC",
          platform: "XIAOHONGSHU",
          channel: "XIAOHONGSHU",
          queueOrder: 3,
          status: "PROCESSING",
          attempts: 1,
          startedAt: new Date(),
        },
      },
    },
  });
  cleanupBatchIds.push(historicalBatch.id);

  const recovery = await recoverInterruptedAutomaticBatches();
  expect(recovery.recoveredBatchIds).toContain(currentBatch.id);
  expect(recovery.historicalOrphanCount).toBeGreaterThanOrEqual(1);

  const recoveredBatch = await prisma.auditBatch.findUniqueOrThrow({
    where: { id: currentBatch.id },
  });
  expect(recoveredBatch).toMatchObject({
    status: "PAUSED",
    currentTaskId: null,
    lastErrorCode: "INTERRUPTED_RECOVERED",
  });
  const recoveredOrphans = await prisma.auditTask.findMany({
    where: { batchId: currentBatch.id, queueOrder: { in: [2, 3] } },
    orderBy: { queueOrder: "asc" },
  });
  expect(recoveredOrphans.map((task) => task.status)).toEqual([
    "PENDING",
    "PENDING",
  ]);
  expect(recoveredOrphans.every((task) => task.claimEpoch === null)).toBe(true);
  expect(
    await prisma.auditTask.findFirstOrThrow({
      where: { batchId: historicalBatch.id },
      select: { status: true },
    }),
  ).toMatchObject({ status: "PROCESSING" });

  const continueResponse = await page.request.post(
    `/api/automation/batches/${currentBatch.id}/control`,
    { data: { action: "CONTINUE" } },
  );
  expect(continueResponse.ok()).toBeTruthy();
  const completed = await waitForBatchTerminal(currentBatch.id);
  expect(completed.peakProcessing).toBe(1);

  const finalOrphans = await prisma.auditTask.findMany({
    where: { batchId: currentBatch.id, queueOrder: { in: [2, 3] } },
    orderBy: { queueOrder: "asc" },
    include: { auditResults: true },
  });
  expect(finalOrphans.map((task) => task.status)).toEqual([
    "COMPLETED",
    "COMPLETED",
  ]);
  expect(finalOrphans.map((task) => task.attempts)).toEqual([2, 2]);
  expect(finalOrphans.map((task) => task.auditResults.length)).toEqual([1, 1]);
  expect(finalOrphans[0].finishedAt!.getTime()).toBeLessThanOrEqual(
    finalOrphans[1].finishedAt!.getTime(),
  );
  expect(
    await prisma.auditTask.count({
      where: { batchId: currentBatch.id, status: "PROCESSING" },
    }),
  ).toBe(0);
  const timeoutTask = await prisma.auditTask.findFirstOrThrow({
    where: { batchId: currentBatch.id, queueOrder: 50 },
  });
  expect(timeoutTask.attempts).toBe(2);
});

test("Pause 快速返回、连续三次 Resume 不遗留 PROCESSING，旧 lease 无写权限", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  const { product, campaign } = await auditScope();
  const suffix = Date.now();
  const response = await page.request.post("/api/automation/batches", {
    data: {
      name: `Pause Resume x3 ${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      intervalMs: 1,
      urls: Array.from(
        { length: 4 },
        (_item, index) =>
          `${E2E_ORIGIN}/mock/xhs?case=passed&autoDelay=4000&pause-x3=${suffix}-${index}`,
      ),
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;
  cleanupBatchIds.push(batchId);

  let staleLease:
    | { batchId: string; taskId: string; runEpoch: number; claimEpoch: number }
    | undefined;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const processingTask = await expect
      .poll(
        () =>
          prisma.auditTask.findFirst({
            where: { batchId, status: "PROCESSING" },
          }),
        { timeout: 30_000 },
      )
      .not.toBeNull()
      .then(() =>
        prisma.auditTask.findFirstOrThrow({
          where: { batchId, status: "PROCESSING" },
        }),
      );
    const runningBatch = await prisma.auditBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    expect(processingTask.claimEpoch).toBe(runningBatch.runEpoch);
    staleLease ??= {
      batchId,
      taskId: processingTask.id,
      runEpoch: runningBatch.runEpoch,
      claimEpoch: processingTask.claimEpoch!,
    };

    const pauseStartedAt = Date.now();
    const pauseResponse = await page.request.post(
      `/api/automation/batches/${batchId}/control`,
      { data: { action: "PAUSE" } },
    );
    const pauseDurationMs = Date.now() - pauseStartedAt;
    expect(pauseResponse.ok()).toBeTruthy();
    expect(pauseDurationMs).toBeLessThan(3_000);
    expect(
      await prisma.auditTask.count({
        where: { batchId, status: "PROCESSING" },
      }),
    ).toBe(0);
    expect(
      await prisma.auditBatch.findUniqueOrThrow({ where: { id: batchId } }),
    ).toMatchObject({ status: "PAUSED", currentTaskId: null });

    if (cycle === 0) {
      await expect(
        prisma.$transaction(async (tx) => {
          await lockValidExecutionLease(tx, staleLease!);
          await tx.auditTask.update({
            where: { id: staleLease!.taskId },
            data: { status: "COMPLETED" },
          });
        }),
      ).rejects.toBeInstanceOf(StaleRunnerCompletionError);
    }

    const continueResponse = await page.request.post(
      `/api/automation/batches/${batchId}/control`,
      { data: { action: "CONTINUE" } },
    );
    expect(continueResponse.ok()).toBeTruthy();
  }

  const completed = await waitForBatchTerminal(batchId);
  expect(completed.peakProcessing).toBeLessThanOrEqual(1);
  expect(
    await prisma.auditTask.count({ where: { batchId, status: "PROCESSING" } }),
  ).toBe(0);
  const tasks = await prisma.auditTask.findMany({
    where: { batchId },
    include: { auditResults: { where: { supersededAt: null } } },
  });
  expect(tasks.every((task) => task.auditResults.length === 1)).toBe(true);
});

test("PROCESSING 已有 Result 时 Resume 直接 terminalize 且不生成第二 Result", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const { product, campaign } = await auditScope();
  const suffix = Date.now();
  const response = await page.request.post("/api/automation/batches", {
    data: {
      name: `已有 Result reconcile ${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      intervalMs: 1,
      urls: `${E2E_ORIGIN}/mock/xhs?case=passed&existing-result=${suffix}`,
    },
  });
  const batchId = (await response.json()).data.batchId as string;
  cleanupBatchIds.push(batchId);
  await waitForBatchTerminal(batchId);
  const task = await prisma.auditTask.findFirstOrThrow({
    where: { batchId },
    include: { auditResults: true },
  });
  expect(task.auditResults).toHaveLength(1);
  const attemptsBefore = task.attempts;
  await prisma.$transaction([
    prisma.auditTask.update({
      where: { id: task.id },
      data: {
        status: "PROCESSING",
        claimEpoch: null,
        finishedAt: null,
      },
    }),
    prisma.auditBatch.update({
      where: { id: batchId },
      data: {
        status: "PAUSED",
        runEpoch: { increment: 1 },
        currentTaskId: null,
        finishedAt: null,
      },
    }),
  ]);

  const continueResponse = await page.request.post(
    `/api/automation/batches/${batchId}/control`,
    { data: { action: "CONTINUE" } },
  );
  expect(continueResponse.ok()).toBeTruthy();
  await waitForBatchTerminal(batchId);
  const recovered = await prisma.auditTask.findUniqueOrThrow({
    where: { id: task.id },
    include: { auditResults: true },
  });
  expect(recovered.status).toBe("COMPLETED");
  expect(recovered.attempts).toBe(attemptsBefore);
  expect(recovered.auditResults).toHaveLength(1);
  expect(recovered.auditResults[0].id).toBe(task.auditResults[0].id);
});

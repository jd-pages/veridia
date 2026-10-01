import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { prisma } from "@/lib/db";
import { recoverInterruptedAutomaticBatches } from "@/lib/automation/batch-execution-reconcile";
import {
  lockValidExecutionLease,
  StaleRunnerCompletionError,
} from "@/lib/automation/execution-lease";
import { DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS } from "@/lib/automation/generation-lifecycle";
import { E2E_ORIGIN } from "./e2e-origin";

const cleanupBatchIds: string[] = [];
const HANDOFF_PROGRESS_TIMEOUT_MS =
  DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS + 15_000;
const LIFECYCLE_DIAGNOSTIC_TIMEOUT_MS = 3_000;

type LifecycleFailureDiagnostics = {
  capture: (phase: string) => Promise<void>;
  snapshots: Array<Record<string, unknown>>;
};

let lifecycleFailureDiagnostics: LifecycleFailureDiagnostics | undefined;

async function boundedDiagnostic<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("LIFECYCLE_DIAGNOSTIC_DEADLINE")),
          LIFECYCLE_DIAGNOSTIC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lifecycleDiagnostics(page: Page, batchIds: string[], startedAt: number) {
  const snapshots: Array<Record<string, unknown>> = [];
  return {
    snapshots,
    async capture(phase: string) {
      const observedAt = new Date().toISOString();
      const results = await Promise.allSettled([
        boundedDiagnostic(prisma.auditBatch.findMany({
          where: { id: { in: batchIds } },
          select: {
            id: true,
            status: true,
            runEpoch: true,
            currentTaskId: true,
            startedAt: true,
            finishedAt: true,
            lastErrorCode: true,
            tasks: {
              orderBy: { queueOrder: "asc" },
              select: {
                id: true,
                status: true,
                queueOrder: true,
                claimEpoch: true,
                attempts: true,
                startedAt: true,
                finishedAt: true,
                failureCode: true,
                auditResults: {
                  select: { id: true, autoStatus: true, pageStatus: true, auditedAt: true },
                },
              },
            },
          },
        }).then((batches) => batches.map((batch) => ({
          ...batch,
          taskStatusCounts: batch.tasks.reduce<Record<string, number>>(
            (counts, task) => {
              counts[task.status] = (counts[task.status] || 0) + 1;
              return counts;
            },
            {},
          ),
        })))),
        boundedDiagnostic((async () => {
          const response = await page.request.get(
            "/api/automation/session?platform=XIAOHONGSHU",
            { timeout: LIFECYCLE_DIAGNOSTIC_TIMEOUT_MS },
          );
          if (!response.ok()) return { status: response.status() };
          const session = (await response.json()).data;
          return {
            status: response.status(),
            generationLifecycle: session.generationLifecycle,
            browserRunning: session.browserRunning,
            controlState: session.controlState,
            controlReady: session.controlReady,
            profileLocked: session.profileLocked,
            activeBrowserOwnerGeneration: session.activeBrowserOwnerGeneration,
            contextLaunchCount: session.contextLaunchCount,
            remoteDebuggingMode: session.remoteDebuggingMode,
            browserProcessId: session.browserProcessId,
            reusedBrowserProcess: session.reusedBrowserProcess,
            pageCount: session.pageCount,
            auditPageOpen: session.auditPageOpen,
            auditLock: session.auditLock,
            lifecycleStages: session.lifecycleStages,
            lifecyclePendingOperations: session.lifecyclePendingOperations,
            physicalCloseState: session.physicalCloseState,
            globalRuntimeDiagnostics: session.globalRuntimeDiagnostics,
          };
        })()),
        boundedDiagnostic((async () => {
          const response = await page.request.get("/api/health", {
            timeout: LIFECYCLE_DIAGNOSTIC_TIMEOUT_MS,
          });
          return { status: response.status(), ready: response.ok() };
        })()),
      ]);
      snapshots.push({
        phase,
        observedAt,
        elapsedMs: Date.now() - startedAt,
        database: results[0].status === "fulfilled" ? results[0].value : "DIAGNOSTIC_FAILED",
        session: results[1].status === "fulfilled" ? results[1].value : "DIAGNOSTIC_FAILED",
        health: results[2].status === "fulfilled" ? results[2].value : "DIAGNOSTIC_FAILED",
      });
    },
  } satisfies LifecycleFailureDiagnostics;
}

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

async function waitForBatchTerminal(
  batchId: string,
  timeoutMs = 180_000,
  diagnostics?: LifecycleFailureDiagnostics,
) {
  const deadline = Date.now() + timeoutMs;
  let peakProcessing = 0;
  let nextDiagnosticAt = 0;
  while (Date.now() < deadline) {
    const [batch, processing] = await Promise.all([
      prisma.auditBatch.findUniqueOrThrow({ where: { id: batchId } }),
      prisma.auditTask.count({ where: { batchId, status: "PROCESSING" } }),
    ]);
    peakProcessing = Math.max(peakProcessing, processing);
    expect(processing).toBeLessThanOrEqual(1);
    if (["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(batch.status)) {
      await diagnostics?.capture("BATCH_TERMINAL");
      return { batch, peakProcessing };
    }
    if (diagnostics && Date.now() >= nextDiagnosticAt) {
      await diagnostics.capture("TERMINAL_WAIT");
      nextDiagnosticAt = Date.now() + 1_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待自动审核批次结束超时：${batchId}`);
}

async function waitForGenerationLifecycleIdle(page: Page) {
  let latest:
    | {
        activeExtractionCount: number;
        pendingCleanupBarrierCount: number;
        activeBrowserOwnerGenerations: number[];
        effectiveRunnerCount: number;
        recentEvents: Array<{ event: string }>;
      }
    | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          "/api/automation/session?platform=XIAOHONGSHU",
        );
        expect(response.ok()).toBeTruthy();
        latest = (await response.json()).data.generationLifecycle;
        return {
          activeExtractionCount: latest!.activeExtractionCount,
          pendingCleanupBarrierCount: latest!.pendingCleanupBarrierCount,
          effectiveRunnerCount: latest!.effectiveRunnerCount,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      activeExtractionCount: 0,
      pendingCleanupBarrierCount: 0,
      effectiveRunnerCount: 0,
    });
  return latest!;
}

async function waitForRunnerHandoffProgress(
  page: Page,
  input: {
    firstBatchId: string;
    secondBatchId: string;
    startedAt: number;
  },
) {
  const deadline = input.startedAt + HANDOFF_PROGRESS_TIMEOUT_MS;
  const timeline: Array<{
    elapsedMs: number;
    firstStatus: string;
    secondStatus: string;
    firstProcessing: number;
    secondProcessing: number;
    activeExtractionCount: number;
    pendingCleanupBarrierCount: number;
    effectiveRunnerCount: number;
    lastLifecycleEvent: string | null;
  }> = [];
  let previousSignature = "";
  let peakProcessing = 0;

  while (Date.now() < deadline) {
    const [firstBatch, secondBatch, firstProcessing, secondProcessing, sessionResponse] =
      await Promise.all([
        prisma.auditBatch.findUniqueOrThrow({ where: { id: input.firstBatchId } }),
        prisma.auditBatch.findUniqueOrThrow({ where: { id: input.secondBatchId } }),
        prisma.auditTask.count({
          where: { batchId: input.firstBatchId, status: "PROCESSING" },
        }),
        prisma.auditTask.count({
          where: { batchId: input.secondBatchId, status: "PROCESSING" },
        }),
        page.request.get("/api/automation/session?platform=XIAOHONGSHU"),
      ]);
    expect(sessionResponse.ok()).toBeTruthy();
    const lifecycle = (await sessionResponse.json()).data.generationLifecycle as {
      activeExtractionCount: number;
      pendingCleanupBarrierCount: number;
      effectiveRunnerCount: number;
      recentEvents: Array<{ event: string }>;
    };
    const processing = firstProcessing + secondProcessing;
    peakProcessing = Math.max(peakProcessing, processing);
    expect(processing).toBeLessThanOrEqual(1);
    expect(lifecycle.activeExtractionCount).toBeLessThanOrEqual(1);
    expect(lifecycle.effectiveRunnerCount).toBeLessThanOrEqual(1);

    const snapshot = {
      elapsedMs: Date.now() - input.startedAt,
      firstStatus: firstBatch.status,
      secondStatus: secondBatch.status,
      firstProcessing,
      secondProcessing,
      activeExtractionCount: lifecycle.activeExtractionCount,
      pendingCleanupBarrierCount: lifecycle.pendingCleanupBarrierCount,
      effectiveRunnerCount: lifecycle.effectiveRunnerCount,
      lastLifecycleEvent: lifecycle.recentEvents.at(-1)?.event ?? null,
    };
    const signature = JSON.stringify({ ...snapshot, elapsedMs: 0 });
    if (signature !== previousSignature) {
      timeline.push(snapshot);
      previousSignature = signature;
    }
    const firstBatchHasActiveWork =
      firstBatch.status === "RUNNING" && firstProcessing === 1;
    const secondBatchHasActiveWork =
      secondBatch.status === "RUNNING" && secondProcessing === 1;
    const handoffProgressed =
      lifecycle.pendingCleanupBarrierCount === 0 &&
      lifecycle.activeExtractionCount === 1 &&
      lifecycle.effectiveRunnerCount === 1 &&
      (firstBatchHasActiveWork || secondBatchHasActiveWork);
    if (handoffProgressed) {
      console.info(
        `[PAUSE_CONTINUE_HANDOFF_TIMELINE] ${JSON.stringify({
          timeoutMs: HANDOFF_PROGRESS_TIMEOUT_MS,
          peakProcessing,
          progressedBatch: firstBatchHasActiveWork ? "FIRST" : "SECOND",
          timeline,
        })}`,
      );
      return {
        elapsedMs: snapshot.elapsedMs,
        peakProcessing,
        progressedBatch: firstBatchHasActiveWork ? "FIRST" : "SECOND",
        timeline,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.info(
    `[PAUSE_CONTINUE_HANDOFF_TIMELINE] ${JSON.stringify({
      timeoutMs: HANDOFF_PROGRESS_TIMEOUT_MS,
      peakProcessing,
      timeline,
    })}`,
  );
  throw new Error(
    `等待 PAUSE_CONTINUE_RUNNER_HANDOFF 进展超时：${HANDOFF_PROGRESS_TIMEOUT_MS}ms`,
  );
}

test.afterEach(async ({ page }, testInfo) => {
  const diagnostics = lifecycleFailureDiagnostics;
  lifecycleFailureDiagnostics = undefined;
  const cleanupErrors: string[] = [];
  if (diagnostics && testInfo.status !== testInfo.expectedStatus) {
    try {
      await diagnostics.capture("FAILURE_BEFORE_CLEANUP");
      await testInfo.attach("pause-continue-lifecycle-diagnostics", {
        body: Buffer.from(JSON.stringify(diagnostics.snapshots, null, 2)),
        contentType: "application/json",
      });
    } catch { cleanupErrors.push("FAILURE_DIAGNOSTICS_ATTACHMENT_FAILED"); }
  }
  for (const batchId of [...new Set(cleanupBatchIds)].reverse()) {
    try {
      const batch = await prisma.auditBatch.findUnique({
        where: { id: batchId }, select: { status: true, clearedAt: true },
      });
      if (!batch || batch.clearedAt) continue;
      if (!["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"].includes(batch.status)) {
        const cancelled = await page.request.post(`/api/automation/batches/${batchId}/control`, {
          data: { action: "CANCEL" }, timeout: LIFECYCLE_DIAGNOSTIC_TIMEOUT_MS,
        });
        if (!cancelled.ok()) cleanupErrors.push(`CANCEL_FAILED:${batchId}:${cancelled.status()}`);
      }
      const cleared = await page.request.post(`/api/automation/batches/${batchId}/clear`, {
        timeout: LIFECYCLE_DIAGNOSTIC_TIMEOUT_MS,
      });
      if (!cleared.ok()) cleanupErrors.push(`CLEAR_FAILED:${batchId}:${cleared.status()}`);
      const [remaining, processing] = await Promise.all([
        prisma.auditBatch.findUnique({ where: { id: batchId }, select: { clearedAt: true } }),
        prisma.auditTask.count({ where: { batchId, status: "PROCESSING" } }),
      ]);
      if (remaining && !remaining.clearedAt) cleanupErrors.push(`BATCH_NOT_CLEARED:${batchId}`);
      if (processing !== 0) cleanupErrors.push(`PROCESSING_AFTER_CLEANUP:${batchId}:${processing}`);
    } catch { cleanupErrors.push(`BATCH_CLEANUP_FAILED:${batchId}`); }
  }
  cleanupBatchIds.length = 0;
  expect(cleanupErrors).toEqual([]);
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
  const lifecycle = await waitForGenerationLifecycleIdle(page);
  expect(
    lifecycle.recentEvents.some(
      (entry) => entry.event === "CLEANUP_BARRIER_WAIT_END",
    ),
  ).toBe(true);
});

test("Protected PAUSE_CONTINUE_RUNNER_HANDOFF：旧 extraction 延迟退出仍有界接管且后续批次不饥饿", async ({
  page,
}, testInfo: TestInfo) => {
  test.setTimeout(150_000);
  const testStartedAt = Date.now();
  const diagnosticBatchIds: string[] = [];
  const diagnostics = lifecycleDiagnostics(page, diagnosticBatchIds, testStartedAt);
  lifecycleFailureDiagnostics = diagnostics;
  await login(page);
  const { product, campaign } = await auditScope();
  const suffix = Date.now();
  const firstResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `Runner handoff ${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      intervalMs: 1,
      urls: Array.from(
        { length: 3 },
        (_item, index) =>
          `${E2E_ORIGIN}/mock/xhs?case=passed&autoDelay=12000&handoff=${suffix}-${index}`,
      ),
    },
  });
  expect(firstResponse.ok()).toBeTruthy();
  const firstBatchId = (await firstResponse.json()).data.batchId as string;
  cleanupBatchIds.push(firstBatchId);
  diagnosticBatchIds.push(firstBatchId);
  await diagnostics.capture("FIRST_BATCH_CREATED");

  await expect.poll(
    () => prisma.auditTask.count({ where: { batchId: firstBatchId, status: "PROCESSING" } }),
    { timeout: 30_000 },
  ).toBe(1);
  await diagnostics.capture("FIRST_TASK_PROCESSING");

  const pauseStartedAt = Date.now();
  const pauseResponse = await page.request.post(
    `/api/automation/batches/${firstBatchId}/control`,
    { data: { action: "PAUSE" } },
  );
  expect(pauseResponse.ok()).toBeTruthy();
  expect(Date.now() - pauseStartedAt).toBeLessThan(3_000);
  await diagnostics.capture("PAUSE_RETURNED");

  const secondResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `Runner starvation guard ${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      intervalMs: 1,
      urls: `${E2E_ORIGIN}/mock/xhs?case=passed&handoff-next=${suffix}`,
    },
  });
  expect(secondResponse.ok()).toBeTruthy();
  const secondBatchId = (await secondResponse.json()).data.batchId as string;
  cleanupBatchIds.push(secondBatchId);
  diagnosticBatchIds.push(secondBatchId);
  await diagnostics.capture("SECOND_BATCH_CREATED");

  const continuedAt = Date.now();
  for (let index = 0; index < 3; index += 1) {
    const continueResponse = await page.request.post(
      `/api/automation/batches/${firstBatchId}/control`,
      { data: { action: "CONTINUE" } },
    );
    expect(continueResponse.ok()).toBeTruthy();
  }
  const handoff = await waitForRunnerHandoffProgress(page, {
    firstBatchId,
    secondBatchId,
    startedAt: continuedAt,
  });
  expect(handoff.elapsedMs).toBeLessThan(HANDOFF_PROGRESS_TIMEOUT_MS);
  expect(handoff.peakProcessing).toBeLessThanOrEqual(1);
  await diagnostics.capture("HANDOFF_PROGRESS_OBSERVED");

  // Leave a bounded diagnostic/teardown window inside the existing test budget.
  const terminalDeadline = testStartedAt + testInfo.timeout - 10_000;
  const firstCompleted = await waitForBatchTerminal(
    firstBatchId, Math.max(1, terminalDeadline - Date.now()), diagnostics,
  );
  const secondCompleted = await waitForBatchTerminal(
    secondBatchId, Math.max(1, terminalDeadline - Date.now()), diagnostics,
  );
  expect(firstCompleted.peakProcessing).toBeLessThanOrEqual(1);
  expect(secondCompleted.peakProcessing).toBeLessThanOrEqual(1);
  expect(
    await prisma.auditResult.count({
      where: { task: { batchId: { in: [firstBatchId, secondBatchId] } } },
    }),
  ).toBe(4);
  const completedTasks = await prisma.auditTask.findMany({
    where: { batchId: { in: [firstBatchId, secondBatchId] } },
    select: {
      status: true,
      auditResults: { select: { pageStatus: true } },
    },
  });
  expect(completedTasks).toHaveLength(4);
  for (const task of completedTasks) {
    expect(task.status).toBe("COMPLETED");
    expect(task.auditResults).toEqual([{ pageStatus: "NORMAL" }]);
  }
  expect(
    await prisma.auditBatch.findUniqueOrThrow({ where: { id: secondBatchId } }),
  ).toMatchObject({
    status: expect.stringMatching(/^COMPLETED/u),
    startedAt: expect.any(Date),
  });
  const lifecycle = await waitForGenerationLifecycleIdle(page);
  expect(lifecycle.activeExtractionCount).toBe(0);
  expect(lifecycle.pendingCleanupBarrierCount).toBe(0);
  expect(lifecycle.effectiveRunnerCount).toBe(0);
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

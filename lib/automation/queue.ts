import "server-only";
import type { AuditTask } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runAuditTask } from "@/lib/audit-service";
import {
  automaticFailureLabels,
  toAutomaticExtractionError,
} from "./failure";
import { recordProcessingFailureResult } from "@/lib/processing-failure-result";
import { jitteredDelay } from "./pacing";
import { completedAuditBatchUpdate } from "./task-lifecycle";
import { automationRuntime } from "./platform-runtime";
import { AuditConfigurationError } from "@/lib/audit-configuration";
import {
  automaticAuditQueueState as queueState,
  isAutomaticBatchRuntimeLive,
} from "./runtime-state";
import {
  assertPlatformRouting,
  automationPlatformLabels,
  parseAutomationPlatform,
  resolveTaskAutomationPlatform,
} from "./platform";
import {
  recoverInterruptedAutomaticBatches,
  reconcileBatchExecutionState,
} from "./batch-execution-reconcile";
import {
  isStaleRunnerCompletionError,
  lockValidExecutionLease,
  taskStatusForPersistedResult,
  type AutomaticExecutionLease,
} from "./execution-lease";
import { runWithExtractionDeadline } from "./extraction-deadline";

const LOCAL_MOCK_WAIT_CAP_MS = Math.max(
  1,
  Number(process.env.AUTOMATION_LOCAL_MOCK_WAIT_CAP_MS || 300),
);

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitWhileBatchRunning(
  batchId: string,
  runEpoch: number,
  milliseconds: number,
  lockStatus: string,
  heartbeat: (batchId: string, status: string) => void,
) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    heartbeat(batchId, lockStatus);
    const batch = await prisma.auditBatch.findUnique({
      where: { id: batchId },
      select: { status: true, runEpoch: true },
    });
    if (
      !batch ||
      batch.status !== "RUNNING" ||
      batch.runEpoch !== runEpoch
    ) {
      return false;
    }
    await wait(Math.max(1, Math.min(500, deadline - Date.now())));
  }
  return true;
}

async function recoverInterruptedQueue() {
  await recoverInterruptedAutomaticBatches();
}

async function ensureRecovered() {
  queueState.recovery ??= recoverInterruptedQueue();
  await queueState.recovery;
}

async function keepProcessingOnlyWhileBatchRuns(
  lease: AutomaticExecutionLease,
) {
  const batch = await prisma.auditBatch.findUnique({
    where: { id: lease.batchId },
    select: { status: true, runEpoch: true, currentTaskId: true },
  });
  if (
    batch?.status === "RUNNING" &&
    batch.runEpoch === lease.runEpoch &&
    batch.currentTaskId === lease.taskId
  ) {
    return true;
  }
  await prisma.auditTask.updateMany({
    where: {
      id: lease.taskId,
      status: "PROCESSING",
      claimEpoch: lease.claimEpoch,
    },
    data:
      batch?.status === "CANCELLED"
        ? {
            status: "CANCELLED",
            claimEpoch: null,
            failureCode: "CANCELLED",
            failureMessage: automaticFailureLabels.CANCELLED,
            finishedAt: new Date(),
          }
        : {
            status: "PENDING",
            claimEpoch: null,
            failureCode: null,
            failureMessage: null,
            startedAt: null,
            finishedAt: null,
          },
  });
  return false;
}

async function finalizeBatch(batchId: string, runEpoch: number) {
  const failed = await prisma.auditTask.count({
    where: { batchId, status: { in: ["FAILED", "READ_FAILED"] } },
  });
  const loginExpired = await prisma.auditTask.count({
    where: { batchId, status: "LOGIN_EXPIRED" },
  });
  const finishedAt = new Date();
  await prisma.$transaction([
    prisma.auditTask.updateMany({
      where: { batchId, status: "COMPLETED", finishedAt: null },
      data: { finishedAt },
    }),
    prisma.auditBatch.updateMany({
      where: { id: batchId, status: "RUNNING", runEpoch },
      data: completedAuditBatchUpdate(Boolean(failed || loginExpired), finishedAt),
    }),
  ]);
}

type ClaimNextTaskResult =
  | { kind: "CLAIMED"; task: AuditTask }
  | { kind: "SKIPPED_RESULT" }
  | { kind: "EMPTY" }
  | { kind: "INVARIANT_BLOCKED" };

async function claimNextTask(
  batchId: string,
  runEpoch: number,
): Promise<ClaimNextTaskResult> {
  return prisma.$transaction(async (tx) => {
    const lockedBatch = await tx.auditBatch.updateMany({
      where: {
        id: batchId,
        status: "RUNNING",
        runEpoch,
        currentTaskId: null,
      },
      data: { runEpoch },
    });
    if (lockedBatch.count !== 1) return { kind: "INVARIANT_BLOCKED" };
    const processingCount = await tx.auditTask.count({
      where: { batchId, status: "PROCESSING" },
    });
    if (processingCount > 0) return { kind: "INVARIANT_BLOCKED" };

    const task = await tx.auditTask.findFirst({
      where: { batchId, status: "PENDING" },
      orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }],
    });
    if (!task) return { kind: "EMPTY" };
    const existingResult = await tx.auditResult.findFirst({
      where: { auditTaskId: task.id, supersededAt: null },
      orderBy: { auditedAt: "desc" },
      select: { autoStatus: true, auditedAt: true },
    });
    if (existingResult && task.failureCode !== "MANUAL_RETRY_REQUESTED") {
      await tx.auditTask.updateMany({
        where: { id: task.id, status: "PENDING" },
        data: {
          status: taskStatusForPersistedResult(existingResult.autoStatus),
          claimEpoch: null,
          failureCode: null,
          failureMessage: null,
          finishedAt: existingResult.auditedAt,
        },
      });
      console.info(
        "[自动审核] 已存在审核结果，跳过重复打开",
        JSON.stringify({ batchId, taskId: task.id }),
      );
      return { kind: "SKIPPED_RESULT" };
    }

    const claimed = await tx.auditTask.updateMany({
      where: { id: task.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        claimEpoch: runEpoch,
        attempts: { increment: 1 },
        startedAt: new Date(),
        finishedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (claimed.count !== 1) return { kind: "INVARIANT_BLOCKED" };
    const markedCurrent = await tx.auditBatch.updateMany({
      where: { id: batchId, status: "RUNNING", runEpoch, currentTaskId: null },
      data: { currentTaskId: task.id },
    });
    if (markedCurrent.count !== 1) {
      throw new Error("TASK_CLAIM_BATCH_STATE_DIVERGENCE");
    }
    const processingTask = await tx.auditTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    console.info(
      "[自动审核生命周期] TASK_CLAIMED",
      JSON.stringify({
        batchId,
        taskId: task.id,
        runEpoch,
        claimEpoch: runEpoch,
        queueOrder: task.queueOrder,
      }),
    );
    return { kind: "CLAIMED", task: processingTask };
  });
}

async function processBatch(batchId: string) {
  if (queueState.activeBatchId && queueState.activeBatchId !== batchId) {
    throw new Error("当前已有内容平台自动审核任务正在运行，请完成、暂停或取消当前任务后再启动新任务。");
  }
  const platformTask = await prisma.auditTask.findFirst({
    where: { batchId },
    orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }],
    select: { channel: true, platform: true, url: true },
  });
  const batchPlatform = parseAutomationPlatform(
    (await prisma.auditBatch.findUnique({ where: { id: batchId }, select: { channel: true } }))?.channel,
  );
  const platform = batchPlatform || (platformTask ? resolveTaskAutomationPlatform(platformTask) : null);
  if (!platform) {
    const finishedAt = new Date();
    await prisma.$transaction([
      prisma.auditTask.updateMany({
        where: { batchId, status: { in: ["PENDING", "PROCESSING"] } },
        data: {
          status: "NEEDS_REVIEW",
          failureCode: "CONTENT_CHANNEL_UNKNOWN",
          failureMessage: "无法确定作品内容平台，请检查内容渠道与作品链接",
          finishedAt,
        },
      }),
      prisma.auditBatch.updateMany({
        where: { id: batchId, status: { in: ["QUEUED", "RUNNING"] } },
        data: {
          status: "FAILED",
          lastErrorCode: "CONTENT_CHANNEL_UNKNOWN",
          lastErrorMessage: "批次内容平台无法确定",
          currentTaskId: null,
          finishedAt,
        },
      }),
    ]);
    return;
  }
  const runtime = automationRuntime(platform);
  queueState.activeBatchId = batchId;
  queueState.activePlatform = platform;
  const pacing = await runtime.pacing();
  let completedSinceCooldown = 0;
  const lockStartedAt = new Date().toISOString();
  const startedBatch = await prisma.$transaction(async (tx) => {
    const started = await tx.auditBatch.updateMany({
      where: { id: batchId, status: "QUEUED" },
      data: {
        status: "RUNNING",
        runEpoch: { increment: 1 },
        startedAt: new Date(),
        finishedAt: null,
        pausedAt: null,
      },
    });
    return started.count
      ? tx.auditBatch.findUnique({ where: { id: batchId } })
      : null;
  });
  if (!startedBatch) {
    queueState.activeBatchId = undefined;
    runtime.updateLock(null);
    return;
  }
  const runEpoch = startedBatch.runEpoch;
  console.info(
    "[自动审核生命周期] RUN_EPOCH_CREATED",
    JSON.stringify({ batchId, runEpoch }),
  );

  while (true) {
    const batch = await prisma.auditBatch.findUnique({ where: { id: batchId } });
    if (
      !batch ||
      batch.status !== "RUNNING" ||
      batch.runEpoch !== runEpoch
    ) {
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }

    const claim = await claimNextTask(batchId, runEpoch);
    if (claim.kind === "SKIPPED_RESULT") continue;
    if (claim.kind === "EMPTY") {
      await finalizeBatch(batchId, runEpoch);
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
    if (claim.kind === "INVARIANT_BLOCKED") {
      await reconcileBatchExecutionState({
        batchId,
        reason: "STARTUP",
        liveRunner: false,
      });
      void runtime.cancelActiveExtraction().catch(() => undefined);
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
    const processingTask = claim.task;
    const task = processingTask;
    const lease: AutomaticExecutionLease = {
      batchId,
      taskId: task.id,
      runEpoch,
      claimEpoch: runEpoch,
    };
    runtime.updateLock({
      batchId,
      taskId: task.id,
      startedAt: lockStartedAt,
      status: "PROCESSING",
    });
    const localMock = ["localhost", "127.0.0.1"].includes(
      new URL(processingTask.url).hostname,
    );

    let mustPauseBatch = false;
    let sessionFailureCode = "";
    let extraction: Awaited<ReturnType<typeof runtime.extract>> | null = null;
    try {
      const taskPlatform = resolveTaskAutomationPlatform(processingTask);
      assertPlatformRouting({
        taskPlatform,
        activePlatform: platform,
        browserPlatform: runtime.browserPlatform,
        adapterPlatform: runtime.adapterPlatform,
        classifierPlatform: runtime.classifierPlatform,
      });
      console.info("[自动审核] 平台路由已确认", JSON.stringify({
        batchId,
        taskId: processingTask.id,
        taskChannel: processingTask.channel,
        taskPlatform,
        activePlatform: platform,
        browserSessionType: runtime.browserSessionType,
        profilePath: runtime.profilePath(),
        adapterName: runtime.adapterName,
        adapterPlatform: runtime.adapterPlatform,
        classifierName: runtime.classifierName,
        classifierPlatform: runtime.classifierPlatform,
      }));
      let currentTask = processingTask;
      for (let retry = 0; ; retry += 1) {
        const extractionStartedAt = Date.now();
        try {
          console.info("[自动审核] 开始读取", JSON.stringify({ batchId, taskId: task.id, retry }));
          extraction = await runWithExtractionDeadline({
            operation: runtime.extract(currentTask),
            cancel: runtime.cancelActiveExtraction,
            batchId,
            taskId: task.id,
            runEpoch,
          });
          console.info("[自动审核] 读取完成", JSON.stringify({
            batchId,
            taskId: task.id,
            retry,
            loadDurationMs: Date.now() - extractionStartedAt,
          }));
          break;
        } catch (error) {
          const extractionError = toAutomaticExtractionError(error);
          const retryable = ["LOAD_TIMEOUT", "NETWORK_ERROR"].includes(
            extractionError.code,
          );
          if (!retryable || retry >= pacing.maxNetworkRetries) throw error;
          const baseDelay = retry === 0 ? pacing.firstRetryMs : pacing.secondRetryMs;
          const configuredRetryDelay = jitteredDelay(
            baseDelay,
            Math.round(baseDelay * 1.12),
          );
          const retryDelay = localMock
            ? Math.min(configuredRetryDelay, 300)
            : configuredRetryDelay;
          console.warn("[自动审核] 临时网络异常，等待后重试", JSON.stringify({
            batchId,
            taskId: task.id,
            retry: retry + 1,
            code: extractionError.code,
            waitMs: retryDelay,
          }));
          if (!(await waitWhileBatchRunning(batchId, runEpoch, retryDelay, "RETRY_WAIT", runtime.heartbeatLock))) {
            await prisma.auditTask.updateMany({
              where: {
                id: task.id,
                status: "PROCESSING",
                claimEpoch: lease.claimEpoch,
              },
              data: {
                status: "PENDING",
                claimEpoch: null,
                startedAt: null,
                finishedAt: null,
              },
            });
            queueState.activeBatchId = undefined;
            runtime.updateLock(null);
            return;
          }
          const retried = await prisma.auditTask.updateMany({
            where: {
              id: task.id,
              status: "PROCESSING",
              claimEpoch: lease.claimEpoch,
            },
            data: { attempts: { increment: 1 } },
          });
          if (!retried.count) return;
          currentTask = await prisma.auditTask.findUniqueOrThrow({
            where: { id: task.id },
          });
        }
      }
      if (!extraction) throw new Error("自动提取未返回结果");
      if (!(await keepProcessingOnlyWhileBatchRuns(lease))) {
        return;
      }
      await runAuditTask(processingTask.id, extraction.note, {
        executionLease: lease,
      });
    } catch (error) {
      if (isStaleRunnerCompletionError(error)) return;
      if (!(await keepProcessingOnlyWhileBatchRuns(lease))) {
        return;
      }
      if (error instanceof AuditConfigurationError) {
        await prisma.$transaction(async (tx) => {
          await lockValidExecutionLease(tx, lease);
          await tx.auditTask.updateMany({
            where: {
              id: processingTask.id,
              status: "PROCESSING",
              claimEpoch: lease.claimEpoch,
            },
            data: {
              status: "FAILED",
              claimEpoch: null,
              failureCode: error.code,
              failureMessage: error.message,
              finishedAt: new Date(),
            },
          });
          await tx.auditBatch.updateMany({
            where: { id: batchId, status: "RUNNING", runEpoch },
            data: {
              currentTaskId: null,
              lastErrorCode: error.code,
              lastErrorMessage: error.message,
            },
          });
        });
        console.warn(
          "[自动审核] 运行时规则配置已变化，当前任务已明确失败并继续批次",
          JSON.stringify({
            batchId,
            taskId: processingTask.id,
            code: error.code,
          }),
        );
      } else {
        const extractionError = toAutomaticExtractionError(error);
      const sessionIssue = [
        "LOGIN_EXPIRED",
        "LOGIN_REQUIRED",
        "SECURITY_VERIFICATION",
        "SECURITY_CHECK",
      ].includes(
        extractionError.code,
      );
      const browserControlIssue =
        extractionError.code === "BROWSER_CONTROL_ERROR";
      const technicalReadFailure = [
        "REDIRECT_FAILED",
        "LOAD_TIMEOUT",
        "STRUCTURE_MISMATCH",
        "NETWORK_ERROR",
        "PAGE_READ_FAILED",
        "BODY_NOT_RECOGNIZED",
        "TOPICS_NOT_RECOGNIZED",
      ].includes(extractionError.code);
      sessionFailureCode = extractionError.code;
      if (sessionIssue || browserControlIssue) {
        const securityRestricted = ["SECURITY_VERIFICATION", "SECURITY_CHECK"].includes(
          extractionError.code,
        );
        const paused = await prisma.$transaction(async (tx) => {
          await lockValidExecutionLease(tx, lease);
          await tx.auditTask.updateMany({
            where: {
              id: processingTask.id,
              status: "PROCESSING",
              claimEpoch: lease.claimEpoch,
            },
            data: {
              status: "PENDING",
              claimEpoch: null,
              failureCode: extractionError.code,
              failureMessage: extractionError.message,
              startedAt: null,
              finishedAt: null,
            },
          });
          return tx.auditBatch.updateMany({
            where: { id: batchId, status: "RUNNING", runEpoch },
            data: {
              status: browserControlIssue
                ? "PAUSED"
                : securityRestricted
                  ? "SECURITY_RESTRICTED"
                  : "LOGIN_EXPIRED",
              runEpoch: { increment: 1 },
              currentTaskId: null,
              pausedAt: new Date(),
              lastErrorCode: extractionError.code,
              lastErrorMessage: extractionError.message,
            },
          });
        });
        if (!paused.count) {
          await keepProcessingOnlyWhileBatchRuns(lease);
          return;
        }
        mustPauseBatch = true;
        if (!browserControlIssue) {
          await runtime.markSessionIssue(securityRestricted, extractionError.message);
        }
        console.warn("[自动审核] 基础会话或浏览器控制异常，批次已暂停", JSON.stringify({
          batchId,
          taskId: task.id,
          code: extractionError.code,
        }));
      } else {
        try {
          await recordProcessingFailureResult({
            taskId: processingTask.id,
            status:
              extractionError.code === "NOTE_NOT_FOUND"
                ? "COMPLETED"
                : technicalReadFailure
                  ? "READ_FAILED"
                  : "FAILED",
            failureCode: extractionError.code,
            failureMessage: extractionError.message,
            executionLease: lease,
            batchError: {
              code: extractionError.code,
              message: extractionError.message,
            },
          });
        } catch (persistenceError) {
          if (isStaleRunnerCompletionError(persistenceError)) return;
          throw persistenceError;
        }
      }
      }
    } finally {
      if (!mustPauseBatch) {
        await prisma.auditBatch.updateMany({
          where: {
            id: batchId,
            status: "RUNNING",
            runEpoch,
            currentTaskId: task.id,
          },
          data: { currentTaskId: null },
        });
      }
    }
    if (mustPauseBatch) {
      queueState.activeBatchId = undefined;
      runtime.updateLock({
        batchId,
        taskId: task.id,
        startedAt: lockStartedAt,
        status: sessionFailureCode || "PAUSED",
      });
      return;
    }

    const latestBatch = await prisma.auditBatch.findUnique({
      where: { id: batchId },
    });
    if (
      !latestBatch ||
      latestBatch.status !== "RUNNING" ||
      latestBatch.runEpoch !== runEpoch
    ) {
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
    const nextTask = await prisma.auditTask.findFirst({
      where: { batchId, status: "PENDING" },
      select: { id: true },
    });
    if (!nextTask) {
      await finalizeBatch(batchId, runEpoch);
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
    completedSinceCooldown += 1;
    if (completedSinceCooldown >= pacing.cooldownTaskCount) {
      const cooldownMs = localMock
        ? Math.min(pacing.cooldownMs, LOCAL_MOCK_WAIT_CAP_MS)
        : jitteredDelay(Math.round(pacing.cooldownMs * 0.9), pacing.cooldownMs);
      await prisma.auditBatch.updateMany({
        where: { id: batchId, status: "RUNNING", runEpoch },
        data: {
          lastErrorCode: "ACCESS_COOLDOWN",
          lastErrorMessage: "正在进行访问间隔保护，稍后将自动继续审核",
        },
      });
      console.info("[自动审核] 访问冷却开始", JSON.stringify({ batchId, cooldownMs }));
      if (!(await waitWhileBatchRunning(batchId, runEpoch, cooldownMs, "COOLDOWN", runtime.heartbeatLock))) {
        queueState.activeBatchId = undefined;
        runtime.updateLock(null);
        return;
      }
      console.info("[自动审核] 访问冷却结束", JSON.stringify({ batchId }));
      completedSinceCooldown = 0;
      await prisma.auditBatch.updateMany({
        where: { id: batchId, status: "RUNNING", runEpoch },
        data: { lastErrorCode: null, lastErrorMessage: null },
      });
    }
    const configuredWait = jitteredDelay(pacing.waitMinMs, pacing.waitMaxMs);
    const actualWait = localMock
      ? Math.min(configuredWait, LOCAL_MOCK_WAIT_CAP_MS)
      : configuredWait;
    console.info("[自动审核] 单篇完成等待", JSON.stringify({ batchId, taskId: task.id, waitMs: actualWait }));
    if (!(await waitWhileBatchRunning(batchId, runEpoch, actualWait, "INTER_TASK_WAIT", runtime.heartbeatLock))) {
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
  }
}

async function runQueue() {
  await ensureRecovered();
  while (true) {
    const sessionBlockedBatch = await prisma.auditBatch.findFirst({
      where: {
        clearedAt: null,
        status: { in: ["PAUSED", "LOGIN_EXPIRED", "SECURITY_RESTRICTED"] },
      },
      select: { id: true },
    });
    if (sessionBlockedBatch) return;
    const batch = await prisma.auditBatch.findFirst({
      where: {
        clearedAt: null,
        status: "QUEUED",
      },
      orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (!batch) return;
    await processBatch(batch.id);
  }
}

export function kickAutomaticAuditQueue() {
  if (queueState.runner) {
    queueState.restartRequested = true;
    return;
  }
  if (!queueState.runner) {
    queueState.runner = runQueue()
      .catch((error) => {
        if (queueState.activePlatform) automationRuntime(queueState.activePlatform).updateLock(null);
        console.error(
          "[自动审核队列] 运行失败",
          error instanceof Error ? error.message : "未知错误",
        );
      })
      .finally(() => {
        const restartRequested = queueState.restartRequested;
        queueState.runner = undefined;
        queueState.activeBatchId = undefined;
        queueState.activePlatform = undefined;
        queueState.restartRequested = false;
        if (restartRequested) queueMicrotask(kickAutomaticAuditQueue);
      });
  }
}

export function clearAutomaticBatchRuntime(batchId: string) {
  if (queueState.activeBatchId === batchId) {
    queueState.activeBatchId = undefined;
  }
  return automationRuntime("XIAOHONGSHU").clearLock(batchId) || automationRuntime("DOUYIN").clearLock(batchId);
}

export async function controlAutomaticBatch(
  batchId: string,
  action: "PAUSE" | "CONTINUE" | "CANCEL" | "RETRY_FAILED",
) {
  const batch = await prisma.auditBatch.findFirst({
    where: { id: batchId, clearedAt: null },
  });
  if (!batch) throw new Error("自动审核批次不存在");
  const platform = parseAutomationPlatform(batch.channel) || "XIAOHONGSHU";
  const runtime = automationRuntime(platform);

  if (action === "PAUSE") {
    console.info(
      "[自动审核生命周期] PAUSE_REQUESTED",
      JSON.stringify({ batchId, runEpoch: batch.runEpoch }),
    );
    const paused = await reconcileBatchExecutionState({
      batchId,
      reason: "PAUSE",
      liveRunner: isAutomaticBatchRuntimeLive(batchId),
    });
    queueState.activeBatchId = undefined;
    runtime.updateLock(null);
    void runtime.cancelActiveExtraction().catch(() => undefined);
    console.info(
      "[自动审核生命周期] RUN_EPOCH_INVALIDATED",
      JSON.stringify({
        batchId,
        previousRunEpoch: batch.runEpoch,
        runEpoch: paused.batch?.runEpoch ?? null,
      }),
    );
    if (paused.reconciledTaskIds.length) {
      console.info(
        "[自动审核生命周期] TASK_REQUEUED_AFTER_PAUSE",
        JSON.stringify({ batchId, taskIds: paused.reconciledTaskIds }),
      );
    }
    if (!paused.batch) throw new Error("自动审核批次不存在");
    return paused.batch;
  }

  if (
    ["CONTINUE", "RETRY_FAILED"].includes(action) &&
    batch.lastErrorCode === "BROWSER_CONTROL_ERROR"
  ) {
    try {
      await runtime.ensureBrowserReady();
    } catch {
      throw new Error(
        "审核浏览器连接异常，请先点击“重新启动专用浏览器”，确认控制连接正常后再继续。",
      );
    }
  }

  if (
    action === "CONTINUE" &&
    ["LOGIN_EXPIRED", "SECURITY_RESTRICTED"].includes(batch.status)
  ) {
    const session = await prisma.automationSession.findUnique({
      where: { id: runtime.sessionId },
      select: { status: true },
    });
    if (session?.status !== "READY") {
      throw new Error(`请先在${automationPlatformLabels[platform]}专用浏览器中完成登录或安全验证，并重新检测登录状态。`);
    }

    const legacyPausedTasks = await prisma.auditTask.findMany({
      where: { batchId, status: "LOGIN_EXPIRED" },
      select: { id: true },
    });
    const taskIds = legacyPausedTasks.map((task) => task.id);
    if (taskIds.length) {
      const transientResults = await prisma.auditResult.findMany({
        where: {
          auditTaskId: { in: taskIds },
          supersededAt: null,
          pageStatus: { in: ["LOGIN_EXPIRED", "SECURITY_VERIFICATION"] },
        },
        select: { id: true },
      });
      const resultIds = transientResults.map((result) => result.id);
      await prisma.$transaction([
        prisma.ruleResult.deleteMany({
          where: { auditResultId: { in: resultIds } },
        }),
        prisma.manualReview.deleteMany({
          where: { auditResultId: { in: resultIds } },
        }),
        prisma.auditResult.deleteMany({ where: { id: { in: resultIds } } }),
        prisma.auditTask.updateMany({
          where: { id: { in: taskIds } },
          data: {
            status: "PENDING",
            failureCode: "SESSION_RESUME_REQUESTED",
            failureMessage: "登录或安全验证已完成，等待从断点继续",
            startedAt: null,
            finishedAt: null,
          },
        }),
      ]);
    }
  }

  if (action === "CONTINUE") {
    const reconciled = await reconcileBatchExecutionState({
      batchId,
      reason: "RESUME",
      liveRunner: isAutomaticBatchRuntimeLive(batchId),
    });
    if (reconciled.classification === "LIVE" && reconciled.batch) {
      return reconciled.batch;
    }
    if (reconciled.classification === "REVIEW_REQUIRED") {
      throw new Error(
        "RUNNER_STATE_REVIEW_REQUIRED：执行状态无法安全判定，批次已保持暂停",
      );
    }
    if (reconciled.classification === "HISTORICAL_TERMINAL") {
      throw new Error("已结束批次不能直接继续审核");
    }
    const resumed = await prisma.auditBatch.update({
      where: { id: batchId },
      data: {
        status: "QUEUED",
        currentTaskId: null,
        pausedAt: null,
        finishedAt: null,
        cancelledAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    kickAutomaticAuditQueue();
    return resumed;
  }
  if (action === "CANCEL") {
    const cancelled = await prisma.$transaction(async (tx) => {
      await tx.auditTask.updateMany({
        where: {
          batchId,
          status: { in: ["PENDING", "PROCESSING", "LOGIN_EXPIRED"] },
        },
        data: {
          status: "CANCELLED",
          claimEpoch: null,
          failureCode: "CANCELLED",
          failureMessage: automaticFailureLabels.CANCELLED,
          finishedAt: new Date(),
        },
      });
      return tx.auditBatch.update({
        where: { id: batchId },
        data: {
          status: "CANCELLED",
          runEpoch: { increment: 1 },
          currentTaskId: null,
          cancelledAt: new Date(),
          finishedAt: new Date(),
        },
      });
    });
    queueState.activeBatchId = undefined;
    runtime.updateLock(null);
    void runtime.cancelActiveExtraction().catch(() => undefined);
    return cancelled;
  }
  if (action === "RETRY_FAILED") {
    await prisma.auditTask.updateMany({
      where: {
        batchId,
        status: { in: ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"] },
      },
      data: {
        status: "PENDING",
        failureCode: "MANUAL_RETRY_REQUESTED",
        failureMessage: "用户已明确请求重新审核",
        finishedAt: null,
      },
    });
  }

  const updated = await prisma.auditBatch.update({
    where: { id: batchId },
    data: {
      status: "QUEUED",
      currentTaskId: null,
      pausedAt: null,
      finishedAt: null,
      cancelledAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  kickAutomaticAuditQueue();
  return updated;
}

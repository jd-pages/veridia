import "server-only";
import { prisma } from "@/lib/db";
import { runAuditTask } from "@/lib/audit-service";
import {
  automaticFailureLabels,
  toAutomaticExtractionError,
  type AutomaticFailureCode,
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

const LOCAL_MOCK_WAIT_CAP_MS = Math.max(
  1,
  Number(process.env.AUTOMATION_LOCAL_MOCK_WAIT_CAP_MS || 300),
);

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitWhileBatchRunning(
  batchId: string,
  milliseconds: number,
  lockStatus: string,
  heartbeat: (batchId: string, status: string) => void,
) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    heartbeat(batchId, lockStatus);
    const batch = await prisma.auditBatch.findUnique({
      where: { id: batchId },
      select: { status: true },
    });
    if (!batch || batch.status !== "RUNNING") return false;
    await wait(Math.max(1, Math.min(500, deadline - Date.now())));
  }
  return true;
}

async function recoverInterruptedQueue() {
  // Do not infer a live executor from persisted RUNNING/PROCESSING values.
  // Interrupted batches remain visible for explicit Continue, Cancel, or Clear.
  // New work is already QUEUED and can be started safely below.
}

async function ensureRecovered() {
  queueState.recovery ??= recoverInterruptedQueue();
  await queueState.recovery;
}

async function keepProcessingOnlyWhileBatchRuns(
  batchId: string,
  taskId: string,
) {
  const batch = await prisma.auditBatch.findUnique({
    where: { id: batchId },
    select: { status: true },
  });
  if (batch?.status === "RUNNING") return true;
  await prisma.auditTask.updateMany({
    where: { id: taskId, status: "PROCESSING" },
    data:
      batch?.status === "CANCELLED"
        ? {
            status: "CANCELLED",
            failureCode: "CANCELLED",
            failureMessage: automaticFailureLabels.CANCELLED,
            finishedAt: new Date(),
          }
        : {
            status: "PENDING",
            failureCode: null,
            failureMessage: null,
            startedAt: null,
            finishedAt: null,
          },
  });
  return false;
}

async function finalizeBatch(batchId: string) {
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
      where: { id: batchId, status: "RUNNING" },
      data: completedAuditBatchUpdate(Boolean(failed || loginExpired), finishedAt),
    }),
  ]);
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
  const started = await prisma.auditBatch.updateMany({
    where: { id: batchId, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      finishedAt: null,
      pausedAt: null,
    },
  });
  if (!started.count) {
    queueState.activeBatchId = undefined;
    runtime.updateLock(null);
    return;
  }

  while (true) {
    const batch = await prisma.auditBatch.findUnique({ where: { id: batchId } });
    if (!batch || !["RUNNING", "QUEUED"].includes(batch.status)) {
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }

    const task = await prisma.auditTask.findFirst({
      where: { batchId, status: "PENDING" },
      orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }],
    });
    if (!task) {
      await finalizeBatch(batchId);
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }

    const existingResult = await prisma.auditResult.findFirst({
      where: { auditTaskId: task.id, supersededAt: null },
      orderBy: { auditedAt: "desc" },
      select: { autoStatus: true },
    });
    if (existingResult && task.failureCode !== "MANUAL_RETRY_REQUESTED") {
      await prisma.auditTask.updateMany({
        where: { id: task.id, status: "PENDING" },
        data: {
          status:
            existingResult.autoStatus === "NEEDS_REVIEW"
              ? "NEEDS_REVIEW"
              : "COMPLETED",
          failureCode: null,
          failureMessage: null,
          finishedAt: new Date(),
        },
      });
      console.info("[自动审核] 已存在审核结果，跳过重复打开", JSON.stringify({
        batchId,
        taskId: task.id,
      }));
      continue;
    }

    const claimed = await prisma.auditTask.updateMany({
      where: { id: task.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        startedAt: new Date(),
        finishedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (!claimed.count) continue;
    const processingTask = await prisma.auditTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    const markedCurrent = await prisma.auditBatch.updateMany({
      where: { id: batchId, status: "RUNNING" },
      data: { currentTaskId: task.id },
    });
    if (!markedCurrent.count) {
      await keepProcessingOnlyWhileBatchRuns(batchId, task.id);
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
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
          extraction = await runtime.extract(currentTask);
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
          if (!(await waitWhileBatchRunning(batchId, retryDelay, "RETRY_WAIT", runtime.heartbeatLock))) {
            await prisma.auditTask.update({
              where: { id: task.id },
              data: { status: "PENDING", startedAt: null, finishedAt: null },
            });
            queueState.activeBatchId = undefined;
            runtime.updateLock(null);
            return;
          }
          currentTask = await prisma.auditTask.update({
            where: { id: task.id },
            data: { attempts: { increment: 1 } },
          });
        }
      }
      if (!extraction) throw new Error("自动提取未返回结果");
      if (!(await keepProcessingOnlyWhileBatchRuns(batchId, processingTask.id))) {
        return;
      }
      const auditResult = await runAuditTask(processingTask.id, extraction.note);
      if (extraction.warnings.length || auditResult.autoStatus === "NEEDS_REVIEW") {
        const warningMessage = extraction.warnings
          .map((code) => automaticFailureLabels[code as AutomaticFailureCode] || code)
          .join("；");
        await prisma.auditTask.updateMany({
          where: { id: processingTask.id, status: "PROCESSING" },
          data: {
            status: "NEEDS_REVIEW",
            failureCode: extraction.warnings.join(",") || "NEEDS_REVIEW",
            failureMessage: warningMessage || "固定规则要求人工复核",
            finishedAt: new Date(),
          },
        });
      } else {
        await prisma.auditTask.updateMany({
          where: { id: processingTask.id, status: "PROCESSING" },
          data: { status: "COMPLETED", finishedAt: new Date() },
        });
      }
    } catch (error) {
      if (!(await keepProcessingOnlyWhileBatchRuns(batchId, processingTask.id))) {
        return;
      }
      if (error instanceof AuditConfigurationError) {
        await prisma.$transaction([
          prisma.auditTask.updateMany({
            where: { id: processingTask.id, status: "PROCESSING" },
            data: {
              status: "FAILED",
              failureCode: error.code,
              failureMessage: error.message,
              finishedAt: new Date(),
            },
          }),
          prisma.auditBatch.updateMany({
            where: { id: batchId, status: "RUNNING" },
            data: {
              lastErrorCode: error.code,
              lastErrorMessage: error.message,
            },
          }),
        ]);
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
        const paused = await prisma.auditBatch.updateMany({
          where: { id: batchId, status: "RUNNING" },
          data: {
            status: browserControlIssue
              ? "PAUSED"
              : securityRestricted
                ? "SECURITY_RESTRICTED"
                : "LOGIN_EXPIRED",
            currentTaskId: null,
            pausedAt: new Date(),
            lastErrorCode: extractionError.code,
            lastErrorMessage: extractionError.message,
          },
        });
        if (!paused.count) {
          await keepProcessingOnlyWhileBatchRuns(batchId, processingTask.id);
          return;
        }
        mustPauseBatch = true;
        // 保留当前断点，不生成失败结果；重新检测成功后从同一条继续。
        await prisma.auditTask.updateMany({
          where: { id: processingTask.id, status: "PROCESSING" },
          data: {
            status: "PENDING",
            failureCode: extractionError.code,
            failureMessage: extractionError.message,
            startedAt: null,
            finishedAt: null,
          },
        });
        if (!browserControlIssue) {
          await runtime.markSessionIssue(securityRestricted, extractionError.message);
        }
        console.warn("[自动审核] 基础会话或浏览器控制异常，批次已暂停", JSON.stringify({
          batchId,
          taskId: task.id,
          code: extractionError.code,
        }));
      } else {
        await prisma.auditBatch.updateMany({
          where: { id: batchId, status: "RUNNING" },
          data: {
            lastErrorCode: extractionError.code,
            lastErrorMessage: extractionError.message,
          },
        });
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
        });
      }
      }
    } finally {
      if (!mustPauseBatch) {
        await prisma.auditBatch.update({
          where: { id: batchId },
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
    if (!latestBatch || latestBatch.status !== "RUNNING") {
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
    const nextTask = await prisma.auditTask.findFirst({
      where: { batchId, status: "PENDING" },
      select: { id: true },
    });
    if (!nextTask) {
      await finalizeBatch(batchId);
      queueState.activeBatchId = undefined;
      runtime.updateLock(null);
      return;
    }
    completedSinceCooldown += 1;
    if (completedSinceCooldown >= pacing.cooldownTaskCount) {
      const cooldownMs = localMock
        ? Math.min(pacing.cooldownMs, LOCAL_MOCK_WAIT_CAP_MS)
        : jitteredDelay(Math.round(pacing.cooldownMs * 0.9), pacing.cooldownMs);
      await prisma.auditBatch.update({
        where: { id: batchId },
        data: {
          lastErrorCode: "ACCESS_COOLDOWN",
          lastErrorMessage: "正在进行访问间隔保护，稍后将自动继续审核",
        },
      });
      console.info("[自动审核] 访问冷却开始", JSON.stringify({ batchId, cooldownMs }));
      if (!(await waitWhileBatchRunning(batchId, cooldownMs, "COOLDOWN", runtime.heartbeatLock))) {
        queueState.activeBatchId = undefined;
        runtime.updateLock(null);
        return;
      }
      console.info("[自动审核] 访问冷却结束", JSON.stringify({ batchId }));
      completedSinceCooldown = 0;
      await prisma.auditBatch.update({
        where: { id: batchId },
        data: { lastErrorCode: null, lastErrorMessage: null },
      });
    }
    const configuredWait = jitteredDelay(pacing.waitMinMs, pacing.waitMaxMs);
    const actualWait = localMock
      ? Math.min(configuredWait, LOCAL_MOCK_WAIT_CAP_MS)
      : configuredWait;
    console.info("[自动审核] 单篇完成等待", JSON.stringify({ batchId, taskId: task.id, waitMs: actualWait }));
    if (!(await waitWhileBatchRunning(batchId, actualWait, "INTER_TASK_WAIT", runtime.heartbeatLock))) {
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
        queueState.runner = undefined;
        queueState.activeBatchId = undefined;
        queueState.activePlatform = undefined;
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

  if (["RUNNING", "QUEUED"].includes(batch.status) && action === "CONTINUE") {
    if (isAutomaticBatchRuntimeLive(batchId)) return batch;
    await prisma.auditTask.updateMany({
      where: { batchId, status: "PROCESSING" },
      data: {
        status: "PENDING",
        failureCode: "INTERRUPTED_RUNTIME_RECOVERY",
        failureMessage: "检测到执行进程已中断，等待用户继续后重新入队",
        startedAt: null,
        finishedAt: null,
      },
    });
    const resumed = await prisma.auditBatch.update({
      where: { id: batchId },
      data: {
        status: "QUEUED",
        currentTaskId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    kickAutomaticAuditQueue();
    return resumed;
  }

  if (action === "PAUSE") {
    return prisma.auditBatch.update({
      where: { id: batchId },
      data: { status: "PAUSED", pausedAt: new Date() },
    });
  }
  if (action === "CANCEL") {
    await prisma.auditTask.updateMany({
      where: {
        batchId,
        status: { in: ["PENDING", "PROCESSING", "LOGIN_EXPIRED"] },
      },
      data: {
        status: "CANCELLED",
        failureCode: "CANCELLED",
        failureMessage: automaticFailureLabels.CANCELLED,
        finishedAt: new Date(),
      },
    });
    const cancelled = await prisma.auditBatch.update({
      where: { id: batchId },
      data: {
        status: "CANCELLED",
        currentTaskId: null,
        cancelledAt: new Date(),
        finishedAt: new Date(),
      },
    });
    if (!queueState.activeBatchId) runtime.updateLock(null);
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

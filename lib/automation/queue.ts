import "server-only";
import { prisma } from "@/lib/db";
import { runAuditTask } from "@/lib/audit-service";
import { extractAuditTaskAutomatically } from "./extract";
import {
  automaticFailureLabels,
  toAutomaticExtractionError,
} from "./failure";
import { markXiaohongshuLoginRequired } from "./browser";

type QueueState = {
  runner?: Promise<void>;
  recovery?: Promise<void>;
};

const globalForQueue = globalThis as typeof globalThis & {
  automaticAuditQueueState?: QueueState;
};
const queueState =
  globalForQueue.automaticAuditQueueState ??
  (globalForQueue.automaticAuditQueueState = {});

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function recoverInterruptedQueue() {
  await prisma.$transaction([
    prisma.auditTask.updateMany({
      where: { status: "PROCESSING" },
      data: {
        status: "PENDING",
        failureCode: "NETWORK_ERROR",
        failureMessage: "服务重启后自动恢复队列",
      },
    }),
    prisma.auditBatch.updateMany({
      where: { status: "RUNNING" },
      data: { status: "QUEUED", currentTaskId: null },
    }),
  ]);
}

async function ensureRecovered() {
  queueState.recovery ??= recoverInterruptedQueue();
  await queueState.recovery;
}

async function finalizeBatch(batchId: string) {
  const failed = await prisma.auditTask.count({
    where: { batchId, status: { in: ["FAILED", "READ_FAILED"] } },
  });
  const loginExpired = await prisma.auditTask.count({
    where: { batchId, status: "LOGIN_EXPIRED" },
  });
  await prisma.auditBatch.update({
    where: { id: batchId },
    data: {
      status:
        failed || loginExpired ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      currentTaskId: null,
      finishedAt: new Date(),
    },
  });
}

async function processBatch(batchId: string) {
  await prisma.auditBatch.update({
    where: { id: batchId },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      finishedAt: null,
      pausedAt: null,
    },
  });

  while (true) {
    const batch = await prisma.auditBatch.findUnique({ where: { id: batchId } });
    if (!batch || !["RUNNING", "QUEUED"].includes(batch.status)) return;

    const task = await prisma.auditTask.findFirst({
      where: { batchId, status: "PENDING" },
      orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }],
    });
    if (!task) {
      await finalizeBatch(batchId);
      return;
    }

    const processingTask = await prisma.auditTask.update({
      where: { id: task.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        startedAt: new Date(),
        finishedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    await prisma.auditBatch.update({
      where: { id: batchId },
      data: { status: "RUNNING", currentTaskId: task.id },
    });

    let mustPauseForLogin = false;
    try {
      const extraction = await extractAuditTaskAutomatically(processingTask);
      const auditResult = await runAuditTask(processingTask.id, extraction.note);
      if (extraction.warnings.length || auditResult.autoStatus === "NEEDS_REVIEW") {
        const warningMessage = extraction.warnings
          .map((code) => automaticFailureLabels[code])
          .join("；");
        await prisma.auditTask.update({
          where: { id: processingTask.id },
          data: {
            status: "NEEDS_REVIEW",
            failureCode: extraction.warnings.join(",") || "NEEDS_REVIEW",
            failureMessage: warningMessage || "固定规则要求人工复核",
            finishedAt: new Date(),
          },
        });
      } else {
        await prisma.auditTask.update({
          where: { id: processingTask.id },
          data: { status: "COMPLETED", finishedAt: new Date() },
        });
      }
    } catch (error) {
      const extractionError = toAutomaticExtractionError(error);
      mustPauseForLogin = [
        "LOGIN_EXPIRED",
        "LOGIN_REQUIRED",
        "SECURITY_VERIFICATION",
        "SECURITY_CHECK",
      ].includes(
        extractionError.code,
      );
      const technicalReadFailure = [
        "REDIRECT_FAILED",
        "LOAD_TIMEOUT",
        "STRUCTURE_MISMATCH",
        "NETWORK_ERROR",
        "PAGE_READ_FAILED",
        "BODY_NOT_RECOGNIZED",
        "TOPICS_NOT_RECOGNIZED",
      ].includes(extractionError.code);
      await prisma.auditTask.update({
        where: { id: processingTask.id },
        data: {
          status: mustPauseForLogin
            ? "LOGIN_EXPIRED"
            : technicalReadFailure
              ? "READ_FAILED"
              : "FAILED",
          failureCode: extractionError.code,
          failureMessage: extractionError.message,
          finishedAt: new Date(),
        },
      });
      await prisma.auditBatch.update({
        where: { id: batchId },
        data: {
          lastErrorCode: extractionError.code,
          lastErrorMessage: extractionError.message,
        },
      });
      if (mustPauseForLogin) {
        await markXiaohongshuLoginRequired(extractionError.message);
        await prisma.auditBatch.update({
          where: { id: batchId },
          data: {
            status: "LOGIN_EXPIRED",
            currentTaskId: null,
            pausedAt: new Date(),
          },
        });
      }
    } finally {
      if (!mustPauseForLogin) {
        await prisma.auditBatch.update({
          where: { id: batchId },
          data: { currentTaskId: null },
        });
      }
    }
    if (mustPauseForLogin) return;

    const latestBatch = await prisma.auditBatch.findUnique({
      where: { id: batchId },
    });
    if (!latestBatch || latestBatch.status !== "RUNNING") return;
    const localMock = ["localhost", "127.0.0.1"].includes(
      new URL(processingTask.url).hostname,
    );
    await wait(localMock ? Math.min(latestBatch.intervalMs, 300) : latestBatch.intervalMs);
  }
}

async function runQueue() {
  await ensureRecovered();
  while (true) {
    const batch = await prisma.auditBatch.findFirst({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
      orderBy: { createdAt: "asc" },
    });
    if (!batch) return;
    await processBatch(batch.id);
  }
}

export function kickAutomaticAuditQueue() {
  if (!queueState.runner) {
    queueState.runner = runQueue()
      .catch((error) => {
        console.error(
          "[自动审核队列] 运行失败",
          error instanceof Error ? error.message : "未知错误",
        );
      })
      .finally(() => {
        queueState.runner = undefined;
      });
  }
}

export async function controlAutomaticBatch(
  batchId: string,
  action: "PAUSE" | "CONTINUE" | "CANCEL" | "RETRY_FAILED",
) {
  const batch = await prisma.auditBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error("自动审核批次不存在");

  if (action === "PAUSE") {
    return prisma.auditBatch.update({
      where: { id: batchId },
      data: { status: "PAUSED", pausedAt: new Date() },
    });
  }
  if (action === "CANCEL") {
    await prisma.auditTask.updateMany({
      where: { batchId, status: { in: ["PENDING", "LOGIN_EXPIRED"] } },
      data: {
        status: "CANCELLED",
        failureCode: "CANCELLED",
        failureMessage: automaticFailureLabels.CANCELLED,
        finishedAt: new Date(),
      },
    });
    return prisma.auditBatch.update({
      where: { id: batchId },
      data: {
        status: "CANCELLED",
        currentTaskId: null,
        cancelledAt: new Date(),
        finishedAt: new Date(),
      },
    });
  }
  if (action === "RETRY_FAILED") {
    await prisma.auditTask.updateMany({
      where: {
        batchId,
        status: { in: ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"] },
      },
      data: {
        status: "PENDING",
        failureCode: null,
        failureMessage: null,
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

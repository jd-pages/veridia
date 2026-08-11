import "server-only";
import { prisma } from "@/lib/db";
import { getAuditContext } from "@/lib/audit-service";
import { safePageLogUrl } from "@/lib/automation/page-classification";
import {
  pageStatusForProcessingFailure,
  processingFailureReason,
  processingFailureResultExcludedCodes,
  processingFailureTaskStatuses,
  type ProcessingFailureStatus,
} from "@/lib/processing-failure";
import { resolveTaskAutomationPlatform } from "@/lib/automation/platform";
import {
  markAuditResultSuperseded,
  resolveAuditResultSlot,
} from "@/lib/audit-result-lifecycle";

const globalForFailureBackfill = globalThis as typeof globalThis & {
  processingFailureBackfill?: Promise<number>;
};

function hasProcessingFailureMarker(ruleSnapshot: string) {
  try {
    const snapshot = JSON.parse(ruleSnapshot) as {
      processingFailure?: unknown;
    };
    return Boolean(snapshot.processingFailure);
  } catch {
    return false;
  }
}

export async function recordProcessingFailureResult(input: {
  taskId: string;
  status: ProcessingFailureStatus | "COMPLETED";
  failureCode: string | null;
  failureMessage: string | null;
  finishedAt?: Date;
}) {
  const finishedAt = input.finishedAt || new Date();
  const noteNotFound = [
    "NOTE_NOT_FOUND",
    "PAGE_NOT_FOUND",
    "NOTE_DELETED",
  ].includes(input.failureCode || "");
  const taskScope = await prisma.auditTask.findUnique({
    where: { id: input.taskId },
    select: { productId: true, campaignId: true, productStage: true, channel: true, platform: true, url: true },
  });
  if (!taskScope) throw new Error("审核任务不存在");
  const contentChannel = resolveTaskAutomationPlatform(taskScope);
  if (!contentChannel) throw new Error("审核任务未关联有效内容平台");
  const reason = processingFailureReason(
    input.failureCode,
    input.failureMessage,
    contentChannel,
  );
  const currentContext = await getAuditContext(
    taskScope.productId,
    taskScope.campaignId,
    taskScope.productStage,
    contentChannel,
  );

  return prisma.$transaction(async (tx) => {
    const task = await tx.auditTask.findUnique({
      where: { id: input.taskId },
      include: {
        campaign: true,
        product: true,
        auditResults: {
          where: { supersededAt: null },
          orderBy: { auditedAt: "desc" },
          take: 1,
        },
      },
    });
    if (!task) throw new Error("审核任务不存在");
    if (task.status === "CANCELLED") return null;

    await tx.auditTask.update({
      where: { id: task.id },
      data: {
        status: input.status,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage || reason,
        finishedAt,
      },
    });

    // A pure infrastructure failure during re-audit does not constitute a new
    // business result. Keep the previous valid result current until a complete
    // audit result (including NOTE_NOT_FOUND) is saved successfully.
    if (task.replacesResultId && !noteNotFound) {
      const previousResult = await tx.auditResult.findFirst({
        where: { id: task.replacesResultId, supersededAt: null },
      });
      if (!previousResult) {
        throw new Error("待重新审核的原结果不存在或已被更新");
      }
      return previousResult;
    }

    const existingNote = await tx.noteRecord.findFirst({
      where: { url: task.url, contentChannel },
    });
    const note = existingNote
      ? await tx.noteRecord.update({
          where: { id: existingNote.id },
          data: {
            contentChannel,
            finalUrl: task.finalUrl,
            title: task.pageTitle,
            body: noteNotFound ? null : undefined,
            publishedAt: null,
            publishedAtRaw: null,
            publishedAtSource: null,
            pageStatus: pageStatusForProcessingFailure(input.failureCode),
            isPublic: noteNotFound ? null : undefined,
            noteType: task.pageType || "UNKNOWN",
            imageExtractionStatus: "NOT_CHECKED",
            imageCount: 0,
            lastCapturedAt: finishedAt,
          },
        })
      : await tx.noteRecord.create({
          data: {
            contentChannel,
            url: task.url,
            finalUrl: task.finalUrl,
            title: task.pageTitle,
            publishedAt: null,
            publishedAtRaw: null,
            publishedAtSource: null,
            pageStatus: pageStatusForProcessingFailure(input.failureCode),
            noteType: task.pageType || "UNKNOWN",
            imageExtractionStatus: "NOT_CHECKED",
            imageCount: 0,
          },
        });

    if (task.failureEvidence) {
      const existingEvidence = await tx.extractionRecord.findFirst({
        where: { auditTaskId: task.id },
        select: { id: true },
      });
      if (!existingEvidence) {
        await tx.extractionRecord.create({
          data: {
            auditTaskId: task.id,
            noteId: note.id,
            adapterName: "playwright-page-evidence",
            adapterVersion: "1.0.0",
            pageStatus: pageStatusForProcessingFailure(input.failureCode),
            rawData: task.failureEvidence,
            extractedAt: finishedAt,
          },
        });
      }
    }

    await tx.noteProduct.upsert({
      where: {
        noteId_productId: {
          noteId: note.id,
          productId: task.productId,
        },
      },
      create: {
        noteId: note.id,
        productId: task.productId,
        isPrimary: true,
      },
      update: { isPrimary: true },
    });

    const snapshot = JSON.stringify({
      ...currentContext,
      productName: task.product.name,
      processingFailure: {
        code: input.failureCode,
        taskStatus: input.status,
        attempts: task.attempts,
      },
    });
    const resultData = {
      noteId: note.id,
      ruleVersion: currentContext.ruleVersion,
      softwareVersion: task.softwareVersion || "unknown",
      rulePackageVersion: currentContext.rulePackageVersion,
      ruleSnapshot: snapshot,
      pageStatus: pageStatusForProcessingFailure(input.failureCode),
      bodyStatus: "UNKNOWN",
      effectiveBodyLength: 0,
      bodyCompliant: true,
      noteType: task.pageType || "UNKNOWN",
      imageExtractionStatus: "NOT_CHECKED",
      imageStatus: "NOT_REQUIRED",
      imageCount: 0,
      imageCompliant: true,
      topicsCompliant: true,
      clickableCompliant: true,
      storeTopicStatus: "NOT_CHECKED",
      expectedStoreTopic: null,
      matchedStoreTopic: null,
      storeTopicFailureReason: null,
      missingTopics: "[]",
      forbiddenTopics: "[]",
      autoStatus: noteNotFound ? "NOTE_NOT_FOUND" : "NEEDS_REVIEW",
      publicStatus: "UNKNOWN",
      retentionStatus: noteNotFound ? "NOT_REQUIRED" : "PENDING",
      visualReviewStatus: "NOT_REQUIRED",
      visualReviewDetails: "{}",
      failureReasons: JSON.stringify([reason]),
      aiStatus: "DISABLED",
      auditedAt: finishedAt,
    };
    const latestResult = task.auditResults[0];

    let savedResult;
    if (
      latestResult &&
      hasProcessingFailureMarker(latestResult.ruleSnapshot)
    ) {
      savedResult = await tx.auditResult.update({
        where: { id: latestResult.id },
        data: resultData,
      });
    } else {
      const resultSlot = await resolveAuditResultSlot(tx, task);
      savedResult = await tx.auditResult.create({
        data: {
          auditTaskId: task.id,
          originTaskId: resultSlot.originTaskId,
          resultSlotOrder: resultSlot.resultSlotOrder,
          resultSlotCreatedAt: resultSlot.resultSlotCreatedAt,
          ...resultData,
        },
      });
      if (resultSlot.replacementResultId) {
        await markAuditResultSuperseded(tx, {
          previousResultId: resultSlot.replacementResultId,
          nextResultId: savedResult.id,
          supersededAt: finishedAt,
        });
      }
    }
    if (noteNotFound) {
      console.info(
        "[自动审核] 笔记不存在结果已保存",
        JSON.stringify({
          taskId: task.id,
          resultId: savedResult.id,
          originalUrl: safePageLogUrl(task.url),
          finalUrl: task.finalUrl ? safePageLogUrl(task.finalUrl) : null,
          pageTitle: task.pageTitle,
          failureCode: "NOTE_NOT_FOUND",
          recordedAt: finishedAt.toISOString(),
          status: "NOTE_NOT_FOUND",
        }),
      );
    }
    return savedResult;
  });
}

async function runMissingProcessingFailureBackfill() {
  let completed = 0;
  while (true) {
    const tasks = await prisma.auditTask.findMany({
      where: {
        status: { in: [...processingFailureTaskStatuses] },
        failureCode: { notIn: [...processingFailureResultExcludedCodes] },
        auditResults: { none: {} },
        OR: [
          { replacesResultId: null },
          {
            failureCode: {
              in: ["NOTE_NOT_FOUND", "PAGE_NOT_FOUND", "NOTE_DELETED"],
            },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        failureCode: true,
        failureMessage: true,
        finishedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    if (!tasks.length) return completed;

    for (const task of tasks) {
      await recordProcessingFailureResult({
        taskId: task.id,
        status: task.status as ProcessingFailureStatus,
        failureCode: task.failureCode,
        failureMessage: task.failureMessage,
        finishedAt: task.finishedAt || undefined,
      });
      completed += 1;
    }
  }
}

export async function backfillMissingProcessingFailureResults() {
  globalForFailureBackfill.processingFailureBackfill ??=
    runMissingProcessingFailureBackfill().finally(() => {
      globalForFailureBackfill.processingFailureBackfill = undefined;
    });
  return globalForFailureBackfill.processingFailureBackfill;
}

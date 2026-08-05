import "server-only";
import { prisma } from "@/lib/db";
import { getAuditContext } from "@/lib/audit-service";
import { safePageLogUrl } from "@/lib/automation/page-classification";
import {
  pageStatusForProcessingFailure,
  processingFailureReason,
  processingFailureTaskStatuses,
  type ProcessingFailureStatus,
} from "@/lib/processing-failure";

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
  const reason = processingFailureReason(
    input.failureCode,
    input.failureMessage,
  );
  const finishedAt = input.finishedAt || new Date();
  const noteNotFound = [
    "NOTE_NOT_FOUND",
    "PAGE_NOT_FOUND",
    "NOTE_DELETED",
  ].includes(input.failureCode || "");
  const taskScope = await prisma.auditTask.findUnique({
    where: { id: input.taskId },
    select: { productId: true, campaignId: true, productStage: true },
  });
  if (!taskScope) throw new Error("审核任务不存在");
  const currentContext = await getAuditContext(
    taskScope.productId,
    taskScope.campaignId,
    taskScope.productStage,
  );

  return prisma.$transaction(async (tx) => {
    const task = await tx.auditTask.findUnique({
      where: { id: input.taskId },
      include: {
        campaign: true,
        product: true,
        auditResults: {
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

    const existingNote = await tx.noteRecord.findUnique({
      where: { url: task.url },
    });
    const note = existingNote
      ? await tx.noteRecord.update({
          where: { id: existingNote.id },
          data: {
            finalUrl: task.finalUrl,
            title: task.pageTitle,
            body: noteNotFound ? null : undefined,
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
            url: task.url,
            finalUrl: task.finalUrl,
            title: task.pageTitle,
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
    const replacementResult = task.replacesResultId
      ? await tx.auditResult.findUnique({
          where: { id: task.replacesResultId },
        })
      : null;
    const latestResult = replacementResult || task.auditResults[0];

    let savedResult;
    if (replacementResult) {
      await tx.ruleResult.deleteMany({
        where: { auditResultId: replacementResult.id },
      });
      savedResult = await tx.auditResult.update({
        where: { id: replacementResult.id },
        data: { ...resultData, auditTaskId: task.id },
      });
    } else if (
      latestResult &&
      hasProcessingFailureMarker(latestResult.ruleSnapshot)
    ) {
      savedResult = await tx.auditResult.update({
        where: { id: latestResult.id },
        data: resultData,
      });
    } else {
      savedResult = await tx.auditResult.create({
        data: {
          auditTaskId: task.id,
          ...resultData,
        },
      });
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
        auditResults: { none: {} },
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

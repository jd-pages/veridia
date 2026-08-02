import "server-only";
import { prisma } from "@/lib/db";
import { getAuditContext } from "@/lib/audit-service";
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
  status: ProcessingFailureStatus;
  failureCode: string | null;
  failureMessage: string | null;
  finishedAt?: Date;
}) {
  const reason = processingFailureReason(
    input.failureCode,
    input.failureMessage,
  );
  const finishedAt = input.finishedAt || new Date();
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
    const note =
      existingNote ||
      (await tx.noteRecord.create({
        data: {
        url: task.url,
        finalUrl: task.finalUrl,
        title: task.pageTitle,
        pageStatus: pageStatusForProcessingFailure(input.failureCode),
        noteType: task.pageType || "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: 0,
      },
      }));

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
      missingTopics: "[]",
      forbiddenTopics: "[]",
      autoStatus: "NEEDS_REVIEW",
      publicStatus: "UNKNOWN",
      retentionStatus: "PENDING",
      visualReviewStatus: "NOT_REQUIRED",
      visualReviewDetails: "{}",
      failureReasons: JSON.stringify([reason]),
      aiStatus: "DISABLED",
      auditedAt: finishedAt,
    };
    const latestResult = task.auditResults[0];

    if (
      latestResult &&
      hasProcessingFailureMarker(latestResult.ruleSnapshot)
    ) {
      return tx.auditResult.update({
        where: { id: latestResult.id },
        data: resultData,
      });
    }

    return tx.auditResult.create({
      data: {
        auditTaskId: task.id,
        ...resultData,
      },
    });
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

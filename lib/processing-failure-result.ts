import "server-only";
import { prisma } from "@/lib/db";
import { getAuditContext } from "@/lib/audit-service";
import { safePageLogUrl } from "@/lib/automation/page-classification";
import {
  processingFailurePageFacts,
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
import {
  lockValidExecutionLease,
  type AutomaticExecutionLease,
} from "@/lib/automation/execution-lease";
import { processingFailureStoreTopicStatus } from "@/lib/processing-failure";
import { buildAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import type { PageStatus } from "@/lib/types";

const globalForFailureBackfill = globalThis as typeof globalThis & {
  processingFailureBackfill?: Promise<number>;
};

type ProcessingFailureSubmission = {
  taskId: string;
  status: ProcessingFailureStatus | "COMPLETED";
  failureCode: string | null;
  failureMessage: string | null;
  finishedAt?: Date;
  batchError?: { code: string; message: string };
} & (
  | { executionLease: AutomaticExecutionLease; observedTaskUpdatedAt?: never }
  | { executionLease?: never; observedTaskUpdatedAt: Date }
);

export async function recordProcessingFailureResult(input: ProcessingFailureSubmission) {
  if (input.executionLease && input.executionLease.taskId !== input.taskId) {
    throw new Error("自动审核执行凭证与任务不匹配");
  }
  if (!input.executionLease &&
      (!(input.observedTaskUpdatedAt instanceof Date) || Number.isNaN(input.observedTaskUpdatedAt.getTime()))) {
    return null;
  }
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
    if (input.executionLease) {
      await lockValidExecutionLease(tx, input.executionLease);
    }
    if (input.executionLease) {
      await tx.auditBatch.update({
        where: { id: input.executionLease.batchId },
        data: {
          currentTaskId: null,
          lastErrorCode: input.batchError?.code,
          lastErrorMessage: input.batchError?.message,
        },
      });
    }
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
    if (!input.executionLease) {
      // This mode is internal legacy backfill only. Recheck under the write
      // transaction so a task resumed after the read cannot receive stale evidence.
      if (task.updatedAt.getTime() !== input.observedTaskUpdatedAt.getTime()) return null;
      if (!(processingFailureTaskStatuses as readonly string[]).includes(task.status) ||
          task.auditResults.length > 0) return task.auditResults[0] ?? null;
      const locked = await tx.auditTask.updateMany({
        where: {
          id: task.id,
          status: task.status,
          updatedAt: input.observedTaskUpdatedAt,
          auditResults: { none: {} },
        },
        data: { status: task.status },
      });
      if (locked.count !== 1) return null;
    }
    const pageFacts = processingFailurePageFacts(
      input.failureCode,
      task.failureEvidence,
    );

    await tx.auditTask.update({
      where: { id: task.id },
      data: {
        status: input.status,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage || reason,
        finishedAt,
        claimEpoch: null,
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
            pageStatus: pageFacts.pageStatus,
            isPublic:
              pageFacts.publicStatus === "PUBLIC"
                ? true
                : noteNotFound
                  ? null
                  : undefined,
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
            pageStatus: pageFacts.pageStatus,
            isPublic: pageFacts.publicStatus === "PUBLIC" ? true : null,
            noteType: task.pageType || "UNKNOWN",
            imageExtractionStatus: "NOT_CHECKED",
            imageCount: 0,
          },
        });

    let pageEvidence: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(task.failureEvidence || "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pageEvidence = parsed;
    } catch { /* Invalid diagnostics cannot become historical evidence. */ }
    // Keep the established flat diagnostics contract, while canonical snapshot
    // fields override candidates that were never accepted as audit evidence.
    const failureSnapshot: Record<string, unknown> = {
      ...pageEvidence,
      ...buildAuditExtractionSnapshot({
          url: task.url,
          finalUrl: task.finalUrl,
          title: task.pageTitle,
          pageTitle: task.pageTitle,
          pageType: task.pageType,
          body: null,
          topics: [],
          pageStatus: pageFacts.pageStatus as PageStatus,
          isPublic: pageFacts.publicStatus === "PUBLIC" ? true : null,
          extractedAt: finishedAt.toISOString(),
          adapterName: "playwright-page-evidence",
          adapterVersion: "1.0.0",
          pageEvidence,
        }, {
          contentChannel,
          auditedTopics: [],
          publishedAt: null,
          evaluation: { noteType: "UNKNOWN", imageExtractionStatus: "NOT_CHECKED", imageCount: null },
          taskStatus: input.status,
          failure: { code: input.failureCode, message: input.failureMessage || reason },
        }),
    };
    delete failureSnapshot.imageUrls;
    const failureExtraction = await tx.extractionRecord.create({
      data: {
        auditTaskId: task.id,
        noteId: note.id,
        adapterName: "playwright-page-evidence",
        adapterVersion: "1.0.0",
        pageStatus: pageFacts.pageStatus,
        extractedAt: finishedAt,
        rawData: JSON.stringify(failureSnapshot),
      },
    });

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
      extractionRecordId: failureExtraction.id,
      ruleVersion: currentContext.ruleVersion,
      softwareVersion: task.softwareVersion || "unknown",
      rulePackageVersion: currentContext.rulePackageVersion,
      ruleSnapshot: snapshot,
      pageStatus: pageFacts.pageStatus,
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
      storeTopicStatus: processingFailureStoreTopicStatus(task),
      expectedStoreTopic: task.expectedStoreTopic,
      matchedStoreTopic: null,
      expectedStoreTopics: task.expectedStoreTopics,
      requiredStoreTopics: task.requiredStoreTopics,
      matchedStoreTopics: "[]",
      matchedRequiredStoreTopics: "[]",
      storeTopicFailureReason: null,
      missingTopics: "[]",
      forbiddenTopics: "[]",
      autoStatus: noteNotFound ? "NOTE_NOT_FOUND" : "NEEDS_REVIEW",
      publicStatus: pageFacts.publicStatus,
      retentionStatus: noteNotFound ? "NOT_REQUIRED" : "PENDING",
      visualReviewStatus: "NOT_REQUIRED",
      visualReviewDetails: "{}",
      failureReasons: JSON.stringify([reason]),
      aiStatus: "DISABLED",
      auditedAt: finishedAt,
    };
    let savedResult;
    {
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
        updatedAt: true,
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
        observedTaskUpdatedAt: task.updatedAt,
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

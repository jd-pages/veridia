import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isAutomaticBatchRuntimeLive } from "@/lib/automation/runtime-state";

export const MAX_IMPORT_RECORD_DELETE_COUNT = 200;

export type ImportRecordDeletionErrorCode =
  | "INVALID_DELETE_REQUEST"
  | "IMPORT_RECORD_NOT_FOUND"
  | "IMPORT_HAS_ACTIVE_TASK"
  | "IMPORT_DELETE_CONFLICT";

export class ImportRecordDeletionError extends Error {
  constructor(
    message: string,
    readonly code: ImportRecordDeletionErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "ImportRecordDeletionError";
  }
}

export function normalizeImportRecordIds(value: unknown) {
  if (!Array.isArray(value)) {
    throw new ImportRecordDeletionError(
      "请选择要删除的导入记录",
      "INVALID_DELETE_REQUEST",
      400,
    );
  }
  if (value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new ImportRecordDeletionError(
      "导入记录 ID 格式不正确",
      "INVALID_DELETE_REQUEST",
      400,
    );
  }
  const ids = [...new Set(value.map((id) => id.trim()))];
  if (!ids.length) {
    throw new ImportRecordDeletionError(
      "请选择要删除的导入记录",
      "INVALID_DELETE_REQUEST",
      400,
    );
  }
  if (ids.length > MAX_IMPORT_RECORD_DELETE_COUNT) {
    throw new ImportRecordDeletionError(
      `单次最多删除 ${MAX_IMPORT_RECORD_DELETE_COUNT} 条导入记录`,
      "INVALID_DELETE_REQUEST",
      400,
    );
  }
  return ids;
}

const activeTaskStatuses = ["STARTING", "PROCESSING", "RETRYING"] as const;
const activeBatchStatuses = ["RUNNING", "RESUMING"] as const;

function parsedActivities(summary: string) {
  try {
    const value = JSON.parse(summary) as {
      activities?: Array<{
        activityId?: string;
        importedName?: string;
        officialName?: string;
      }>;
    };
    return Array.isArray(value.activities) ? value.activities : [];
  } catch {
    return [];
  }
}

async function findPersistedActiveOwner(
  tx: Prisma.TransactionClient,
  ids: string[],
) {
  const activeBatch = await tx.auditBatch.findFirst({
    where: {
      importRecordId: { in: ids },
      OR: [
        { status: { in: [...activeBatchStatuses] } },
        { currentTaskId: { not: null } },
        {
          tasks: {
            some: {
              OR: [
                { status: { in: [...activeTaskStatuses] } },
                { claimEpoch: { not: null } },
              ],
            },
          },
        },
      ],
    },
    select: {
      id: true,
      importRecordId: true,
      name: true,
      status: true,
      currentTaskId: true,
    },
  });
  if (activeBatch) return { kind: "BATCH" as const, ...activeBatch };
  const activeTask = await tx.auditTask.findFirst({
    where: {
      importRecordId: { in: ids },
      OR: [
        { status: { in: [...activeTaskStatuses] } },
        { claimEpoch: { not: null } },
      ],
    },
    select: { id: true, importRecordId: true, status: true, batchId: true },
  });
  return activeTask ? { kind: "TASK" as const, ...activeTask } : null;
}

export async function deleteImportRecordsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    ids: string[];
    userId: string;
    mode: "SINGLE" | "BULK";
  },
) {
  const records = await tx.importRecord.findMany({
    where: { id: { in: input.ids } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      fileName: true,
      importType: true,
      totalCount: true,
      createdAt: true,
      summary: true,
    },
  });
  if (records.length !== input.ids.length) {
    const existingIds = new Set(records.map(({ id }) => id));
    const missingIds = input.ids.filter((id) => !existingIds.has(id));
    throw new ImportRecordDeletionError(
      `导入记录不存在：${missingIds.join("、")}`,
      "IMPORT_RECORD_NOT_FOUND",
      404,
    );
  }

  const batches = await tx.auditBatch.findMany({
    where: { importRecordId: { in: input.ids } },
    select: { id: true, importRecordId: true, name: true },
  });
  const liveBatch = batches.find(({ id }) => isAutomaticBatchRuntimeLive(id));
  if (liveBatch) {
    const blockedRecord = records.find(
      ({ id }) => id === liveBatch.importRecordId,
    );
    throw new ImportRecordDeletionError(
      `导入记录仍有自动审核任务正在执行：${
        blockedRecord
          ? `${blockedRecord.fileName}（${blockedRecord.id}）`
          : liveBatch.importRecordId || "未知导入记录"
      }；执行对象：${liveBatch.name || liveBatch.id}，请先暂停或取消并等待当前执行结束。`,
      "IMPORT_HAS_ACTIVE_TASK",
      409,
    );
  }
  const activeOwner = await findPersistedActiveOwner(tx, input.ids);
  if (activeOwner) {
    const blockedRecord = records.find(
      ({ id }) => id === activeOwner.importRecordId,
    );
    throw new ImportRecordDeletionError(
      `导入记录仍有自动审核任务正在执行：${
        blockedRecord
          ? `${blockedRecord.fileName}（${blockedRecord.id}）`
          : activeOwner.importRecordId || "未知导入记录"
      }；执行对象：${
        activeOwner.kind === "BATCH"
          ? activeOwner.name || activeOwner.id
          : activeOwner.id
      }，请先暂停或取消并等待当前执行结束。`,
      "IMPORT_HAS_ACTIVE_TASK",
      409,
    );
  }

  const ownershipWhere = { task: { importRecordId: { in: input.ids } } };
  const reviewOwnershipWhere = {
    auditResult: { task: { importRecordId: { in: input.ids } } },
  };
  const [taskCount, resultCount, extractionCount, ruleResultCount, reviewCount] =
    await Promise.all([
      tx.auditTask.count({ where: { importRecordId: { in: input.ids } } }),
      tx.auditResult.count({ where: ownershipWhere }),
      tx.extractionRecord.count({ where: ownershipWhere }),
      tx.ruleResult.count({ where: reviewOwnershipWhere }),
      tx.manualReview.count({ where: reviewOwnershipWhere }),
    ]);

  const deletedReviews = await tx.manualReview.deleteMany({
    where: reviewOwnershipWhere,
  });
  const deletedRuleResults = await tx.ruleResult.deleteMany({
    where: reviewOwnershipWhere,
  });
  const deletedResults = await tx.auditResult.deleteMany({
    where: ownershipWhere,
  });
  const deletedExtractions = await tx.extractionRecord.deleteMany({
    where: ownershipWhere,
  });
  const deletedTasks = await tx.auditTask.deleteMany({
    where: { importRecordId: { in: input.ids } },
  });
  const deletedBatches = await tx.auditBatch.deleteMany({
    where: { importRecordId: { in: input.ids } },
  });
  const deletedImports = await tx.importRecord.deleteMany({
    where: { id: { in: input.ids } },
  });
  if (
    deletedReviews.count !== reviewCount ||
    deletedRuleResults.count !== ruleResultCount ||
    deletedResults.count !== resultCount ||
    deletedExtractions.count !== extractionCount ||
    deletedTasks.count !== taskCount ||
    deletedBatches.count !== batches.length ||
    deletedImports.count !== records.length
  ) {
    throw new ImportRecordDeletionError(
      "导入记录联动删除发生并发冲突，本次操作已回滚，请刷新后重试。",
      "IMPORT_DELETE_CONFLICT",
      409,
    );
  }

  const deletedIds = records.map(({ id }) => id);
  const deletedAt = new Date().toISOString();
  const metadata = {
    requestedIds: input.ids,
    deletedIds,
    deletedImportCount: records.length,
    deletedBatchCount: batches.length,
    deletedTaskCount: taskCount,
    deletedResultCount: resultCount,
    deletedExtractionCount: extractionCount,
    deletedRuleResultCount: ruleResultCount,
    deletedManualReviewCount: reviewCount,
    deletedAt,
    sharedNoteRecordsRetained: true,
    records: records.map((record) => ({
      id: record.id,
      fileName: record.fileName,
      importType: record.importType,
      totalCount: record.totalCount,
      importedAt: record.createdAt.toISOString(),
      activities: parsedActivities(record.summary),
    })),
  };
  await tx.operationLog.create({
    data: {
      userId: input.userId,
      action:
        input.mode === "SINGLE"
          ? "DELETE_IMPORT_RECORD"
          : "BULK_DELETE_IMPORT_RECORDS",
      entityType: "IMPORT_RECORD",
      entityId: input.mode === "SINGLE" ? input.ids[0] : null,
      summary:
        input.mode === "SINGLE"
          ? `删除导入记录：${records[0].fileName}，任务 ${taskCount} 条，结果 ${resultCount} 条`
          : `批量删除导入记录 ${records.length} 条，任务 ${taskCount} 条，结果 ${resultCount} 条`,
      metadata: JSON.stringify(metadata),
    },
  });

  return { ...metadata, deletedBatchIds: batches.map(({ id }) => id) };
}

export async function deleteImportRecords(input: {
  ids: string[];
  userId: string;
  mode: "SINGLE" | "BULK";
}) {
  const result = await prisma.$transaction(
    (tx) => deleteImportRecordsInTransaction(tx, input),
    { timeout: 60_000 },
  );
  const { clearAutomaticBatchRuntime, kickAutomaticAuditQueue } = await import(
    "@/lib/automation/queue"
  );
  for (const batchId of result.deletedBatchIds) {
    clearAutomaticBatchRuntime(batchId);
  }
  kickAutomaticAuditQueue();
  return result;
}

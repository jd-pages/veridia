import type { Prisma } from "@prisma/client";

export const currentAuditResultWhere = {
  supersededAt: null,
} satisfies Prisma.AuditResultWhereInput;

export interface AuditResultVersionTask {
  id: string;
  batchId: string | null;
  importRecordId: string | null;
  queueOrder: number;
  replacesResultId: string | null;
  createdAt: Date;
}

export interface AuditResultSlot {
  originTaskId: string;
  resultSlotOrder: number;
  resultSlotCreatedAt: Date;
  replacementResultId: string | null;
}

export async function resolveAuditResultSlot(
  tx: Prisma.TransactionClient,
  task: AuditResultVersionTask,
): Promise<AuditResultSlot> {
  const requestedReplacement = task.replacesResultId
    ? await tx.auditResult.findUnique({
        where: { id: task.replacesResultId },
        select: {
          id: true,
          auditTaskId: true,
          originTaskId: true,
          resultSlotOrder: true,
          resultSlotCreatedAt: true,
          createdAt: true,
          supersededAt: true,
        },
      })
    : null;
  if (task.replacesResultId && !requestedReplacement) {
    throw new Error("待重新审核的原结果不存在");
  }
  if (requestedReplacement?.supersededAt) {
    throw new Error("待重新审核的结果已被更新，请刷新后重新选择最新结果");
  }

  const sameTaskCurrent = task.replacesResultId
    ? null
    : await tx.auditResult.findFirst({
        where: { auditTaskId: task.id, supersededAt: null },
        orderBy: [{ auditedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          auditTaskId: true,
          originTaskId: true,
          resultSlotOrder: true,
          resultSlotCreatedAt: true,
          createdAt: true,
          supersededAt: true,
        },
      });
  const replacement = requestedReplacement || sameTaskCurrent;
  if (replacement) {
    return {
      originTaskId: replacement.originTaskId || replacement.auditTaskId,
      resultSlotOrder: replacement.resultSlotOrder,
      resultSlotCreatedAt:
        replacement.resultSlotCreatedAt || replacement.createdAt,
      replacementResultId: replacement.id,
    };
  }

  const [importRecord, batch] = await Promise.all([
    task.importRecordId
      ? tx.importRecord.findUnique({
          where: { id: task.importRecordId },
          select: { createdAt: true },
        })
      : null,
    task.batchId
      ? tx.auditBatch.findUnique({
          where: { id: task.batchId },
          select: { createdAt: true },
        })
      : null,
  ]);
  return {
    originTaskId: task.id,
    resultSlotOrder: task.queueOrder,
    resultSlotCreatedAt:
      importRecord?.createdAt || batch?.createdAt || task.createdAt,
    replacementResultId: null,
  };
}

export async function markAuditResultSuperseded(
  tx: Prisma.TransactionClient,
  input: {
    previousResultId: string;
    nextResultId: string;
    supersededAt: Date;
  },
) {
  const updated = await tx.auditResult.updateMany({
    where: { id: input.previousResultId, supersededAt: null },
    data: {
      supersededAt: input.supersededAt,
      supersededByResultId: input.nextResultId,
    },
  });
  if (updated.count !== 1) {
    throw new Error("重新审核结果版本发生冲突，请刷新后重试");
  }
}

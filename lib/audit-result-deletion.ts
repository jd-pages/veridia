import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { processingFailureTaskStatuses } from "@/lib/processing-failure";

export const MAX_AUDIT_RESULT_DELETE_COUNT = 200;

export class AuditResultDeletionValidationError extends Error {}

export function normalizeAuditResultIds(value: unknown) {
  if (!Array.isArray(value)) {
    throw new AuditResultDeletionValidationError("请选择要删除的审核结果");
  }
  if (value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new AuditResultDeletionValidationError("审核结果 ID 格式不正确");
  }
  const ids = [...new Set(value.map((id) => id.trim()))];
  if (!ids.length) {
    throw new AuditResultDeletionValidationError("请选择要删除的审核结果");
  }
  if (ids.length > MAX_AUDIT_RESULT_DELETE_COUNT) {
    throw new AuditResultDeletionValidationError(
      `单次最多删除 ${MAX_AUDIT_RESULT_DELETE_COUNT} 条审核结果`,
    );
  }
  return ids;
}

export async function deleteAuditResultsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    ids: string[];
    userId: string;
    mode: "SINGLE" | "BULK";
  },
) {
  const existing = await tx.auditResult.findMany({
    where: { id: { in: input.ids } },
    select: { id: true, auditTaskId: true, noteId: true },
  });
  const deletedIds = existing.map(({ id }) => id);
  const affectedTaskIds = [...new Set(existing.map(({ auditTaskId }) => auditTaskId))];
  const affectedNoteIds = [...new Set(existing.map(({ noteId }) => noteId))];
  let closedFailureTaskIds: string[] = [];

  if (deletedIds.length) {
    await tx.manualReview.deleteMany({
      where: { auditResultId: { in: deletedIds } },
    });
    await tx.ruleResult.deleteMany({
      where: { auditResultId: { in: deletedIds } },
    });
    const deleted = await tx.auditResult.deleteMany({
      where: { id: { in: deletedIds } },
    });
    if (deleted.count !== deletedIds.length) {
      throw new Error("审核结果删除数量不一致");
    }

    const failureTasksWithoutResults = await tx.auditTask.findMany({
      where: {
        id: { in: affectedTaskIds },
        status: { in: [...processingFailureTaskStatuses] },
        auditResults: { none: {} },
      },
      select: { id: true },
    });
    closedFailureTaskIds = failureTasksWithoutResults.map(({ id }) => id);
    if (closedFailureTaskIds.length) {
      await tx.auditTask.updateMany({
        where: { id: { in: closedFailureTaskIds } },
        data: {
          status: "CANCELLED",
          failureCode: "CANCELLED",
          failureMessage: "对应审核结果已删除，可重新提交审核",
        },
      });
    }
  }

  await tx.operationLog.create({
    data: {
      userId: input.userId,
      action:
        input.mode === "SINGLE"
          ? "DELETE_AUDIT_RESULT"
          : "BULK_DELETE_AUDIT_RESULTS",
      entityType: "AUDIT_RESULT",
      entityId: input.mode === "SINGLE" ? input.ids[0] : null,
      summary:
        input.mode === "SINGLE"
          ? `删除审核结果 ${deletedIds[0] || input.ids[0]}，实际删除 ${deletedIds.length} 条`
          : `批量删除审核结果 ${deletedIds.length} 条`,
      metadata: JSON.stringify({
        requestedIds: input.ids,
        deletedIds,
        deletedCount: deletedIds.length,
        affectedTaskIds,
        affectedNoteIds,
        closedFailureTaskIds,
        taskRecordsRetained: true,
        noteRecordsRetained: true,
      }),
    },
  });

  return { deletedCount: deletedIds.length, deletedIds };
}

export function deleteAuditResults(input: {
  ids: string[];
  userId: string;
  mode: "SINGLE" | "BULK";
}) {
  return prisma.$transaction((tx) =>
    deleteAuditResultsInTransaction(tx, input),
  );
}

import type { Prisma } from "@prisma/client";

export const visibleAuditTaskWhere: Prisma.AuditTaskWhereInput = {
  OR: [{ batchId: null }, { batch: { is: { clearedAt: null } } }],
};

export const duplicateRelevantAuditTaskWhere: Prisma.AuditTaskWhereInput = {
  OR: [
    { auditResults: { some: { supersededAt: null } } },
    {
      status: "PENDING",
      OR: [
        { batchId: null },
        {
          batch: {
            is: {
              clearedAt: null,
              status: {
                in: [
                  "QUEUED",
                  "RUNNING",
                  "RESUMING",
                  "PAUSED",
                  "LOGIN_EXPIRED",
                  "SECURITY_RESTRICTED",
                ],
              },
            },
          },
        },
      ],
    },
    {
      status: "PROCESSING",
      batch: { is: { clearedAt: null } },
    },
  ],
};

export const clearableAutomaticBatchStatuses = [
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "READ_FAILED",
  "CANCELLED",
  "PAUSED",
  "LOGIN_EXPIRED",
  "SECURITY_RESTRICTED",
  "SECURITY_VERIFICATION",
] as const;

const clearableStatusSet = new Set<string>(clearableAutomaticBatchStatuses);

export function canClearAutomaticBatch(input: {
  status: string;
  processingTaskCount?: number;
  currentTaskId?: string | null;
}) {
  return (
    clearableStatusSet.has(input.status) &&
    !input.processingTaskCount &&
    !input.currentTaskId
  );
}

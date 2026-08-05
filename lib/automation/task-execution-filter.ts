import type { Prisma } from "@prisma/client";

export const taskExecutionFilters = [
  "ALL",
  "WAITING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "NEEDS_REVIEW",
] as const;

export type TaskExecutionFilter = (typeof taskExecutionFilters)[number];

export const taskExecutionFilterLabels: Record<TaskExecutionFilter, string> = {
  ALL: "全部",
  WAITING: "等待中",
  PROCESSING: "处理中",
  SUCCEEDED: "成功",
  FAILED: "处理失败",
  NEEDS_REVIEW: "待人工复核",
};

export const taskExecutionStatusGroups = {
  WAITING: ["PENDING", "QUEUED"],
  PROCESSING: ["PROCESSING", "RUNNING"],
  SUCCEEDED: ["COMPLETED"],
  FAILED: ["FAILED", "READ_FAILED"],
} as const;

export function parseTaskExecutionFilter(
  value: unknown,
): TaskExecutionFilter | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!normalized) return "ALL";
  return taskExecutionFilters.includes(normalized as TaskExecutionFilter)
    ? (normalized as TaskExecutionFilter)
    : null;
}

export function buildTaskExecutionFilterWhere(
  filter: TaskExecutionFilter,
): Prisma.AuditTaskWhereInput {
  if (filter === "ALL") return {};
  if (filter === "NEEDS_REVIEW") {
    const hasNoTerminalManualReview = {
      none: { result: { in: ["PASSED", "FAILED"] } },
    };
    return {
      OR: [
        {
          status: "NEEDS_REVIEW",
          auditResults: {
            some: { manualReviews: hasNoTerminalManualReview },
          },
        },
        {
          status: { in: ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"] },
          auditResults: {
            some: {
              autoStatus: "NEEDS_REVIEW",
              manualReviews: hasNoTerminalManualReview,
            },
          },
        },
        {
          auditResults: {
            some: {
              manualReviews: {
                some: { result: "NEEDS_REVIEW" },
                ...hasNoTerminalManualReview,
              },
            },
          },
        },
      ],
    };
  }
  return {
    status: { in: [...taskExecutionStatusGroups[filter]] },
  };
}

export function countTaskStatuses(
  counts: ReadonlyMap<string, number>,
  statuses: readonly string[],
) {
  return statuses.reduce((total, status) => total + (counts.get(status) || 0), 0);
}

import type { Prisma } from "@prisma/client";

/**
 * Presentation-only status corrections for persisted retention-era rows.
 * The IDs are resolved from immutable result evidence in one bounded query;
 * no historical row is rewritten.
 */
export interface RetentionBusinessClassificationIds {
  normalizedPassIds: string[];
  normalizedManualReviewIds: string[];
  normalizedFailedIds: string[];
}

export function allNormalizedRetentionIds(
  classification: RetentionBusinessClassificationIds,
) {
  return [...new Set([
    ...classification.normalizedPassIds,
    ...classification.normalizedManualReviewIds,
    ...classification.normalizedFailedIds,
  ])];
}

export function buildRetentionStatusNormalizations(
  rows: Array<{ id: string; autoStatus: string }>,
  classification: RetentionBusinessClassificationIds,
) {
  const passedIds = new Set(classification.normalizedPassIds);
  const reviewIds = new Set(classification.normalizedManualReviewIds);
  const failedIds = new Set(classification.normalizedFailedIds);
  const output = {
    passed: {} as Record<string, number>,
    review: {} as Record<string, number>,
    failed: {} as Record<string, number>,
  };
  for (const row of rows) {
    const target = passedIds.has(row.id)
      ? output.passed
      : reviewIds.has(row.id)
        ? output.review
        : failedIds.has(row.id)
          ? output.failed
          : null;
    if (target) target[row.autoStatus] = (target[row.autoStatus] || 0) + 1;
  }
  return output;
}

const emptyIds: string[] = [];

export function pendingRetentionWhere(): Prisma.AuditResultWhereInput {
  // Accepted as a legacy API filter, but no longer represents a business state.
  return { id: { in: emptyIds } };
}

export function normalizedPassWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  return { id: { in: classification?.normalizedPassIds || emptyIds } };
}

export function normalizedFailedWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  return { id: { in: classification?.normalizedFailedIds || emptyIds } };
}

export function manualReviewWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  if (!classification) return { autoStatus: "NEEDS_REVIEW" };
  return {
    OR: [
      {
        autoStatus: "NEEDS_REVIEW",
        id: {
          notIn: [
            ...classification.normalizedPassIds,
            ...classification.normalizedFailedIds,
          ],
        },
      },
      { id: { in: classification.normalizedManualReviewIds } },
    ],
  };
}

export function passedWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  if (!classification) return { autoStatus: "PASSED" };
  return {
    AND: [
      {
        OR: [
          { autoStatus: "PASSED" },
          normalizedPassWhere(classification),
        ],
      },
      {
        id: {
          notIn: [
            ...classification.normalizedManualReviewIds,
            ...classification.normalizedFailedIds,
          ],
        },
      },
    ],
  };
}

export function failedWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  if (!classification) return { autoStatus: "FAILED" };
  return {
    AND: [
      {
        OR: [
          { autoStatus: "FAILED" },
          normalizedFailedWhere(classification),
        ],
      },
      {
        id: {
          notIn: [
            ...classification.normalizedPassIds,
            ...classification.normalizedManualReviewIds,
          ],
        },
      },
    ],
  };
}

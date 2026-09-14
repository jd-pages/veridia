import type { Prisma } from "@prisma/client";

export interface RetentionBusinessClassificationIds {
  pendingIds: string[];
  retentionManualReviewIds: string[];
}

const reviewRuleWhere: Prisma.RuleResultWhereInput = {
  AND: [
    { ruleKey: { not: "GLOBAL_RETENTION" } },
    {
      OR: [
        { actualValue: { contains: "UNKNOWN" } },
        { actualValue: { contains: "UNREVIEWABLE" } },
        { actualValue: { contains: "无法确认" } },
        { actualValue: { contains: "需人工" } },
        { actualValue: { contains: "待人工" } },
        { actualValue: { contains: "读取失败" } },
        { actualValue: { contains: "未识别" } },
        { failureReason: { contains: "需人工" } },
        { failureReason: { contains: "无法确认" } },
        { evidence: { contains: '"clickabilityNeedsReview":true' } },
        { evidence: { contains: '"technicalWarning"' } },
      ],
    },
  ],
};

const failedMandatoryRuleWhere: Prisma.RuleResultWhereInput = {
  passed: false,
  OR: [
    { ruleKey: { startsWith: "TOPIC_" } },
    {
      ruleKey: {
        in: [
          "BUSINESS_RULE_SCOPE",
          "GLOBAL_PAGE_STATUS",
          "GLOBAL_IMAGE_COUNT",
          "GLOBAL_BODY",
          "PRODUCT_STAGE_BODY",
          "GLOBAL_PUBLIC_STATUS",
          "GLOBAL_RETENTION",
          "STORE_TOPIC",
          "KABRITA_BASIC_REWARD",
        ],
      },
    },
  ],
};

/** Persisted facts that can be classified without rewriting legacy rows. */
export const retentionOnlyPendingWhere: Prisma.AuditResultWhereInput = {
  AND: [
    { pageStatus: "NORMAL" },
    { publicStatus: "PUBLIC" },
    { retentionStatus: "PENDING" },
    { bodyStatus: { not: "UNKNOWN" } },
    { bodyCompliant: true },
    { imageStatus: { notIn: ["IMAGES_READ_FAILED", "NOT_CHECKED"] } },
    { imageCompliant: true },
    { topicsCompliant: true },
    { clickableCompliant: true },
    { storeTopicStatus: { notIn: ["NON_COMPLIANT", "UNREVIEWABLE"] } },
    { interactionRewardStatus: { not: "PENDING" } },
    { failureReasons: { in: ["[]", ""] } },
    { ruleResults: { none: failedMandatoryRuleWhere } },
    { ruleResults: { none: reviewRuleWhere } },
  ],
};

export const pendingRetentionBusinessWhere: Prisma.AuditResultWhereInput = {
  OR: [
    { autoStatus: "PENDING_RETENTION" },
    retentionOnlyPendingWhere,
  ],
};

export const trueManualReviewWhere: Prisma.AuditResultWhereInput = {
  AND: [
    { autoStatus: "NEEDS_REVIEW" },
    { NOT: retentionOnlyPendingWhere },
  ],
};

export const legacyRetentionOnlyPendingWhere: Prisma.AuditResultWhereInput = {
  AND: [
    { autoStatus: { not: "PENDING_RETENTION" } },
    retentionOnlyPendingWhere,
  ],
};

export function pendingRetentionWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  return classification
    ? { id: { in: classification.pendingIds } }
    : pendingRetentionBusinessWhere;
}

export function manualReviewWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  if (!classification) return trueManualReviewWhere;
  return {
    OR: [
      {
        autoStatus: "NEEDS_REVIEW",
        id: { notIn: classification.pendingIds },
      },
      { id: { in: classification.retentionManualReviewIds } },
    ],
  };
}

export function legacyPendingWhere(
  classification?: RetentionBusinessClassificationIds,
): Prisma.AuditResultWhereInput {
  return classification
    ? {
        autoStatus: { not: "PENDING_RETENTION" },
        id: { in: classification.pendingIds },
      }
    : legacyRetentionOnlyPendingWhere;
}

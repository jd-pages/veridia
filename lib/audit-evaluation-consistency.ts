import type { AuditEvaluation } from "@/lib/types";

const MANDATORY_RESULT_KEYS = new Set([
  "BUSINESS_RULE_SCOPE",
  "GLOBAL_PAGE_STATUS",
  "GLOBAL_IMAGE_COUNT",
  "GLOBAL_BODY",
  "PRODUCT_STAGE_BODY",
  "GLOBAL_PUBLIC_STATUS",
  "STORE_TOPIC",
  "KABRITA_BASIC_REWARD",
]);

function isFailedMandatoryResult(
  result: AuditEvaluation["ruleResults"][number],
) {
  return !result.passed && (
    result.ruleKey.startsWith("TOPIC_") ||
    MANDATORY_RESULT_KEYS.has(result.ruleKey)
  );
}

function containsReviewSignal(value: unknown): boolean {
  if (typeof value === "string") {
    return /UNKNOWN|PENDING|UNREVIEWABLE|未识别|无法确认|需人工|待验证|读取失败/u.test(value);
  }
  if (Array.isArray(value)) return value.some(containsReviewSignal);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsReviewSignal);
  }
  return false;
}

/** Reject only structurally impossible states emitted by evaluateAudit. */
export function assertAuditEvaluationConsistency(evaluation: AuditEvaluation) {
  if (
    evaluation.autoStatus === "PASSED" &&
    (
      !evaluation.bodyCompliant ||
      evaluation.imageCompliant === false ||
      !evaluation.topicsCompliant ||
      !evaluation.clickableCompliant ||
      evaluation.pageStatus !== "NORMAL" ||
      evaluation.publicStatus === "NOT_PUBLIC" ||
      evaluation.storeTopicStatus === "NON_COMPLIANT" ||
      evaluation.ruleResults.some(isFailedMandatoryResult)
    )
  ) {
    throw new Error("AUDIT_EVALUATION_INCONSISTENT: PASSED 包含失败的强制审核事实");
  }

  if (evaluation.autoStatus !== "NEEDS_REVIEW") return;
  const hasSignal =
    evaluation.failureReasons.length > 0 ||
    evaluation.pageStatus !== "NORMAL" ||
    evaluation.bodyStatus === "UNKNOWN" ||
    ["IMAGES_READ_FAILED", "NOT_CHECKED"].includes(evaluation.imageStatus) ||
    evaluation.publicStatus === "UNKNOWN" ||
    evaluation.storeTopicStatus === "UNREVIEWABLE" ||
    evaluation.interactionReward?.interactionRewardStatus === "PENDING" ||
    evaluation.ruleResults.some((result) => result.ruleKey !== "GLOBAL_RETENTION" && (
      containsReviewSignal(result.actualValue) ||
      containsReviewSignal(result.failureReason) ||
      containsReviewSignal(result.evidence)
    ),
    );
  if (!hasSignal) {
    throw new Error("AUDIT_EVALUATION_INCONSISTENT: NEEDS_REVIEW 缺少复核信号");
  }
}

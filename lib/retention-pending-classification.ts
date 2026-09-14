import { parseStoredStringArray } from "@/lib/stored-json";

export interface RetentionClassificationRuleResult {
  ruleKey: string;
  actualValue: string;
  failureReason?: string | null;
  evidence: string;
  passed: boolean;
}

export interface RetentionClassificationInput {
  autoStatus: string;
  pageStatus: string;
  bodyStatus: string;
  bodyCompliant: boolean;
  imageStatus: string;
  imageCompliant: boolean | null;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  publicStatus: string;
  retentionStatus: string;
  storeTopicStatus?: string;
  interactionRewardStatus?: string;
  failureReasons: string;
  ruleResults?: RetentionClassificationRuleResult[];
}

const reviewSignalPattern =
  /UNKNOWN|UNREVIEWABLE|未识别|无法确认|需人工|待人工|读取失败/u;

const mandatoryRuleKeys = new Set([
  "BUSINESS_RULE_SCOPE",
  "GLOBAL_PAGE_STATUS",
  "GLOBAL_IMAGE_COUNT",
  "GLOBAL_BODY",
  "PRODUCT_STAGE_BODY",
  "GLOBAL_PUBLIC_STATUS",
  "GLOBAL_RETENTION",
  "STORE_TOPIC",
  "KABRITA_BASIC_REWARD",
]);

function failedMandatoryRule(result: RetentionClassificationRuleResult) {
  return !result.passed && (
    result.ruleKey.startsWith("TOPIC_") || mandatoryRuleKeys.has(result.ruleKey)
  );
}

export function retentionReviewReasons(input: RetentionClassificationInput) {
  const reasons: string[] = [];
  if (input.publicStatus === "UNKNOWN") reasons.push("公开状态待确认");
  if (input.retentionStatus === "UNKNOWN") reasons.push("公开留存期限无法确认");
  if (input.bodyStatus === "UNKNOWN") reasons.push("正文读取结果待确认");
  if (["IMAGES_READ_FAILED", "NOT_CHECKED"].includes(input.imageStatus)) {
    reasons.push("图片读取结果待确认");
  }
  if (input.storeTopicStatus === "UNREVIEWABLE") {
    reasons.push("店铺话题审核证据待确认");
  }
  if (input.interactionRewardStatus === "PENDING") {
    reasons.push("互动奖励待确认");
  }
  const storedReasons = parseStoredStringArray(input.failureReasons);
  if (
    input.autoStatus === "NEEDS_REVIEW" &&
    storedReasons.length &&
    !reasons.length
  ) {
    reasons.push(...storedReasons);
  }
  if (!reasons.length && input.autoStatus === "NEEDS_REVIEW" &&
    (input.ruleResults || []).some((result) => result.ruleKey !== "GLOBAL_RETENTION" && (
      reviewSignalPattern.test(`${result.actualValue} ${result.failureReason || ""}`) ||
      /"clickabilityNeedsReview"\s*:\s*true|"technicalWarning"/u.test(result.evidence)
    ))) {
    reasons.push("审核证据存在待确认项");
  }
  return [...new Set(reasons)];
}

export function hasExplicitAuditFailure(input: RetentionClassificationInput) {
  return input.autoStatus === "FAILED" ||
    !input.bodyCompliant ||
    input.imageCompliant === false ||
    !input.topicsCompliant ||
    !input.clickableCompliant ||
    input.publicStatus === "NOT_PUBLIC" ||
    input.retentionStatus === "NOT_SATISFIED" ||
    input.storeTopicStatus === "NON_COMPLIANT" ||
    (input.ruleResults || []).some(failedMandatoryRule);
}

export function isRetentionOnlyPending(input: RetentionClassificationInput) {
  return input.pageStatus === "NORMAL" &&
    input.publicStatus === "PUBLIC" &&
    input.retentionStatus === "PENDING" &&
    !hasExplicitAuditFailure(input) &&
    retentionReviewReasons(input).length === 0;
}

export function deriveAuditBusinessStatus(input: RetentionClassificationInput) {
  if (["NOTE_NOT_FOUND", "READ_FAILED", "PROCESSING"].includes(input.autoStatus)) {
    return input.autoStatus;
  }
  if (input.pageStatus === "NOTE_NOT_FOUND") return "NOTE_NOT_FOUND";
  if (hasExplicitAuditFailure(input)) return "FAILED";
  if (retentionReviewReasons(input).length) return "NEEDS_REVIEW";
  if (isRetentionOnlyPending(input)) return "PENDING_RETENTION";
  return input.autoStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : input.autoStatus;
}

import {
  duplicateReauditMetadataFromNotes,
  legacyZeroHistoryDuplicateMetadataFromNotes,
} from "@/lib/import-task-metadata";
import {
  auditConclusionFailureReasons,
  minimumImageCountFromRuleSnapshot,
} from "@/lib/result-detail-presentation";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { parseStoredStringArray } from "@/lib/stored-json";
import { normalizeTopic } from "@/lib/topic";
import { topicAuditRuleSummary } from "@/lib/topic-audit-summary";
import {
  deriveAuditBusinessStatus,
  retentionReviewReasons,
} from "@/lib/retention-pending-classification";
import { retentionDaysFromRuleSnapshot } from "@/lib/retention-status";
import { brandUsesStoreTopicAudit } from "@/lib/store-topic-config";

export type AuditResultPresentationTone =
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "neutral";

export type AuditResultConsistencyStatus =
  | "CONSISTENT"
  | "RESULT_CONSISTENCY_VIOLATION"
  | "HISTORICAL_LEGACY_INCOMPLETE";

export interface AuditResultPresentationTopic {
  source: "PERSISTED_RULE_RESULTS" | "RESULT_BOUND_EXTRACTION" | "LEGACY_UNAVAILABLE";
  status: "COMPLIANT" | "NON_COMPLIANT" | "NEEDS_REVIEW" | "UNAVAILABLE";
  expectedCount: number;
  matchedCount: number;
  required: string[];
  matched: string[];
  missing: string[];
  forbidden: string[];
  unclickable: string[];
  uncertain: string[];
  anyCandidates: string[];
  anyMinimum: number;
  matchedAnyCandidates: string[];
  unmatchedAnyCandidates: string[];
  anyMissingCount: number;
  stageCandidates: string[];
  matchedStageCandidates: string[];
  stageGroupMissing: boolean;
  stageGroupUnclickable: boolean;
  stageGroupUncertain: boolean;
  message: string | null;
}

export interface AuditResultPresentation {
  source: "PERSISTED_AUDIT_RESULT";
  consistency: {
    status: AuditResultConsistencyStatus;
    code: string | null;
    message: string | null;
  };
  automaticConclusion: {
    status: string;
    label: string;
    tone: AuditResultPresentationTone;
  };
  conclusion: {
    status: string;
    label: string;
    tone: AuditResultPresentationTone;
    source: "AUTOMATIC" | "MANUAL";
  };
  failureReasons: string[];
  reviewReasons: string[];
  pendingReasons: string[];
  isManualReviewRequired: boolean;
  isPendingRetention: boolean;
  publicDisplay: { status: string; label: string };
  retentionDisplay: {
    status: string;
    label: string;
    requirementDays: number;
    dueAt: string | null;
  };
  topic: AuditResultPresentationTopic;
  body: { status: string; compliant: boolean; label: string };
  media: {
    kind: "VIDEO" | "IMAGE_TEXT" | "UNKNOWN";
    label: "视频作品" | "图文作品" | "作品类型无法确认";
    imageAuditApplicable: boolean;
    imageCount: number | null;
  };
  image: {
    status: string;
    compliant: boolean | null;
    label: string;
    minimumCount: number | null;
  };
  interactionReward: {
    status: string;
    likeCount: number | null;
    commentCount: number | null;
    favoriteCount: number | null;
    total: number | null;
    threshold: number | null;
  };
  storeTopic: {
    applicable: boolean;
    status: string;
    label: string;
  };
}

interface PresentationRuleResult {
  ruleKey: string;
  ruleName: string;
  expectedValue: string;
  actualValue: string;
  passed: boolean;
  failureReason?: string | null;
  evidence: string;
}

interface PresentationInput {
  autoStatus: string;
  pageStatus: string;
  bodyStatus: string;
  bodyCompliant: boolean;
  imageStatus: string;
  imageCompliant: boolean | null;
  imageCount?: number | null;
  noteType?: string | null;
  imageExtractionStatus?: string | null;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  publicStatus: string;
  retentionStatus: string;
  retentionDueAt?: Date | string | null;
  storeTopicStatus?: string;
  storeTopicFailureReason?: string | null;
  failureReasons: string;
  missingTopics: string;
  forbiddenTopics: string;
  ruleSnapshot: string;
  likeCount?: number | null;
  commentCount?: number | null;
  favoriteCount?: number | null;
  interactionTotal?: number | null;
  interactionRewardThreshold?: number | null;
  interactionRewardStatus?: string;
  evidenceStatus?: "RESULT_BOUND" | "LEGACY_UNAVAILABLE";
  evidenceMessage?: string | null;
  ruleResults?: PresentationRuleResult[];
  note: {
    noteType?: unknown;
    pageType?: unknown;
    imageExtractionStatus?: unknown;
    imageCount?: unknown;
    contentChannel?: unknown;
    platformNoteId?: unknown;
    publishedAt?: unknown;
    publishedAtSource?: unknown;
    url?: string | null;
    title?: string | null;
    body?: string | null;
    topics?: Array<{ displayText?: string; isClickable?: boolean }>;
  };
  task: {
    notes?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
    pageTitle?: string | null;
    pageType?: string | null;
    product?: { brandName?: string | null };
  };
  manualReviews?: Array<{ result: string }>;
}

interface ParsedRuleEvidence {
  dueAt?: unknown;
  expected?: unknown;
  expectedTopics?: unknown;
  matchedCount?: unknown;
  minCount?: unknown;
  clickabilityNeedsReview?: unknown;
  matchedTopics?: unknown;
  acceptedTopics?: unknown;
  candidates?: unknown;
  dom?: unknown;
  technicalWarning?: unknown;
}

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

function isFailedMandatoryResult(result: PresentationRuleResult) {
  return !result.passed && (
    result.ruleKey.startsWith("TOPIC_") ||
    MANDATORY_RESULT_KEYS.has(result.ruleKey)
  );
}

function parseEvidence(value: string): ParsedRuleEvidence {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.map(String).map(normalizeTopic).filter(Boolean)
    : [];
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function boolean(value: unknown) {
  return value === true;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]) {
  return [...new Set(values.map(normalizeTopic).filter(Boolean))];
}

const storeTopicFailurePattern =
  /店铺话题|未命中任何可接受店铺话题|可接受店铺话题|附加必需话题|导入数据未填写店铺名称|导入店铺名称未匹配/u;

function storeTopicScopedPresentationInput(input: PresentationInput) {
  const applicable = brandUsesStoreTopicAudit(input.task.product?.brandName);
  if (applicable) {
    return {
      applicable,
      input,
      results: input.ruleResults || [],
    };
  }

  const storeResults = (input.ruleResults || []).filter(
    (result) => result.ruleKey === "STORE_TOPIC",
  );
  const exactStoreReasons = new Set(
    [input.storeTopicFailureReason, ...storeResults.map((result) => result.failureReason)]
      .flatMap((reason) => String(reason || "").split("；"))
      .map((reason) => reason.trim())
      .filter(Boolean),
  );
  const isStoreReason = (reason: string) =>
    exactStoreReasons.has(reason.trim()) || storeTopicFailurePattern.test(reason);
  const failureReasons = parseStoredStringArray(input.failureReasons).filter(
    (reason) => !isStoreReason(reason),
  );
  const results = (input.ruleResults || []).filter(
    (result) => result.ruleKey !== "STORE_TOPIC",
  );
  const nonStoreTopicFailure = results.some(
    (result) =>
      !result.passed &&
      (result.ruleKey.startsWith("TOPIC_") ||
        result.ruleKey === "PRODUCT_STAGE_BODY"),
  ) || parseStoredStringArray(input.missingTopics).length > 0 ||
    parseStoredStringArray(input.forbiddenTopics).length > 0;
  const taskFailureMessage = input.task.failureMessage &&
      isStoreReason(input.task.failureMessage)
    ? null
    : input.task.failureMessage;
  const normalizedAutomaticStatus =
    ["FAILED", "NEEDS_REVIEW"].includes(input.autoStatus) &&
      failureReasons.length === 0 &&
      !taskFailureMessage
      ? "PASSED"
      : input.autoStatus;

  return {
    applicable,
    results,
    input: {
      ...input,
      autoStatus: normalizedAutomaticStatus,
      topicsCompliant:
        input.topicsCompliant ||
        (input.storeTopicStatus === "NON_COMPLIANT" && !nonStoreTopicFailure),
      storeTopicStatus: "NOT_REQUIRED",
      storeTopicFailureReason: null,
      failureReasons: JSON.stringify(failureReasons),
      ruleResults: results,
      task: { ...input.task, failureMessage: taskFailureMessage },
    } satisfies PresentationInput,
  };
}

function topicRuleCoverage(ruleSnapshot: string) {
  try {
    const parsed = JSON.parse(ruleSnapshot) as {
      rules?: Array<{
        id?: unknown;
        ruleType?: unknown;
        topicCategory?: unknown;
      }>;
    };
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    const standardKeys = rules
      .filter((rule) =>
        rule.ruleType !== "ALIAS" &&
        rule.ruleType !== "ANY" &&
        rule.topicCategory !== "PRODUCT_STAGE",
      )
      .map((rule) => String(rule.id || ""))
      .filter(Boolean)
      .map((id) => `TOPIC_${id}`);
    return {
      standardKeys,
      expectsAny: rules.some((rule) =>
        rule.ruleType === "ANY" && rule.topicCategory !== "PRODUCT_STAGE",
      ),
      expectsStage: rules.some((rule) =>
        rule.ruleType !== "ALIAS" && rule.topicCategory === "PRODUCT_STAGE",
      ),
    };
  } catch {
    return { standardKeys: [], expectsAny: false, expectsStage: false };
  }
}

function completePersistedTopicEvidence(
  ruleSnapshot: string,
  topicResults: PresentationRuleResult[],
) {
  const coverage = topicRuleCoverage(ruleSnapshot);
  const keys = new Set(topicResults.map((result) => result.ruleKey));
  return keys.has("TOPIC_TECHNICAL_READ") || (
    coverage.standardKeys.every((key) => keys.has(key)) &&
    (!coverage.expectsAny || keys.has("TOPIC_ANY_GROUP")) &&
    (!coverage.expectsStage || topicResults.some((result) =>
      result.ruleKey.startsWith("TOPIC_PRODUCT_STAGE_GROUP_"),
    ))
  );
}

function topicFromPersistedResults(
  input: PresentationInput,
  results: PresentationRuleResult[],
): AuditResultPresentationTopic {
  const standard = results.filter((result) =>
    result.ruleKey.startsWith("TOPIC_") &&
    result.ruleKey !== "TOPIC_ANY_GROUP" &&
    result.ruleKey !== "TOPIC_TECHNICAL_READ" &&
    !result.ruleKey.startsWith("TOPIC_PRODUCT_STAGE_GROUP_"),
  );
  const requiredResults = standard.filter((result) =>
    result.expectedValue !== "不得出现" && !result.ruleName.startsWith("禁止话题"),
  );
  const forbiddenResults = standard.filter((result) =>
    result.expectedValue === "不得出现" || result.ruleName.startsWith("禁止话题"),
  );
  const required = requiredResults.map((result) => {
    const expected = parseEvidence(result.evidence).expected;
    const fromName = result.ruleName.match(/(#[^\s]+)$/u)?.[1];
    return normalizeTopic(String(expected || fromName || result.ruleName));
  });
  const matched = requiredResults.filter((result) => {
    const evidence = parseEvidence(result.evidence);
    return Boolean(evidence.dom) || /精确出现/u.test(result.actualValue);
  }).map((result) => {
    const expected = parseEvidence(result.evidence).expected;
    const fromName = result.ruleName.match(/(#[^\s]+)$/u)?.[1];
    return normalizeTopic(String(expected || fromName || result.ruleName));
  });
  const missing = requiredResults.filter((result) =>
    !result.passed && /未精确出现|缺少|文字不准确/u.test(
      `${result.actualValue} ${result.failureReason || ""}`,
    ),
  ).map((result) => {
    const expected = parseEvidence(result.evidence).expected;
    const fromName = result.ruleName.match(/(#[^\s]+)$/u)?.[1];
    return normalizeTopic(String(expected || fromName || result.ruleName));
  });
  const forbidden = forbiddenResults.filter((result) => !result.passed)
    .map((result) => {
      const expected = parseEvidence(result.evidence).expected;
      const fromName = result.ruleName.match(/(#[^\s]+)$/u)?.[1];
      return normalizeTopic(String(expected || fromName || result.ruleName));
    });
  const unclickable = requiredResults.filter((result) => {
    const dom = object(parseEvidence(result.evidence).dom);
    return dom.finalClickability === "NOT_CLICKABLE" ||
      /不可点击/u.test(`${result.actualValue} ${result.failureReason || ""}`);
  }).map((result) => {
    const expected = parseEvidence(result.evidence).expected;
    return normalizeTopic(String(expected || result.ruleName));
  });
  const uncertain = requiredResults.filter((result) => {
    const dom = object(parseEvidence(result.evidence).dom);
    return dom.finalClickability === "UNKNOWN" || /需人工确认/u.test(result.actualValue);
  }).map((result) => {
    const expected = parseEvidence(result.evidence).expected;
    return normalizeTopic(String(expected || result.ruleName));
  });

  const any = results.find((result) => result.ruleKey === "TOPIC_ANY_GROUP");
  const anyEvidence = any ? parseEvidence(any.evidence) : {};
  const anyCandidates = strings(anyEvidence.expectedTopics);
  const anyMinimum = any ? Math.max(number(anyEvidence.minCount, 1), 1) : 0;
  const anyCandidateDetails = Array.isArray(anyEvidence.candidates)
    ? anyEvidence.candidates.map(object)
    : [];
  const matchedAnyCandidates = unique(anyCandidateDetails
    .filter((candidate) => boolean(candidate.present) &&
      (!boolean(candidate.effectiveClickableRequired) || candidate.clickability === "CLICKABLE"))
    .map((candidate) => String(candidate.topic || "")));
  const anyMatchedCount = any
    ? Math.min(number(anyEvidence.matchedCount, matchedAnyCandidates.length), anyMinimum)
    : 0;
  const unmatchedAnyCandidates = anyCandidates.filter(
    (candidate) => !matchedAnyCandidates.includes(candidate),
  );
  const anyMissingCount = any && !any.passed
    ? Math.max(anyMinimum - anyMatchedCount, 0)
    : 0;
  const anyUncertain = any
    ? boolean(anyEvidence.clickabilityNeedsReview) || /需人工确认/u.test(any.actualValue)
    : false;

  const stage = results.find((result) =>
    result.ruleKey.startsWith("TOPIC_PRODUCT_STAGE_GROUP_"),
  );
  const stageEvidence = stage ? parseEvidence(stage.evidence) : {};
  const stageCandidates = strings(stageEvidence.expectedTopics);
  const matchedStageCandidates = strings(stageEvidence.matchedTopics);
  const acceptedStageCandidates = strings(stageEvidence.acceptedTopics);
  const stageCandidateDetails = Array.isArray(stageEvidence.candidates)
    ? stageEvidence.candidates.map(object)
    : [];
  const stageGroupMissing = Boolean(stage && !stage.passed && !matchedStageCandidates.length);
  const stageGroupUnclickable = Boolean(
    stage && !stage.passed && matchedStageCandidates.length,
  );
  const stageGroupUncertain = Boolean(
    stage && stage.passed && acceptedStageCandidates.length &&
      stageCandidateDetails
        .filter((candidate) => acceptedStageCandidates.includes(normalizeTopic(String(candidate.topic || ""))))
        .every((candidate) => candidate.clickability === "UNKNOWN"),
  );
  const technicalRead = results.find((result) => result.ruleKey === "TOPIC_TECHNICAL_READ");

  const expectedCount = requiredResults.length + anyMinimum + (stage ? 1 : 0);
  const matchedCount = Math.min(
    matched.length + anyMatchedCount + (stage && stage.passed ? 1 : 0),
    expectedCount,
  );
  const needsReview = Boolean(technicalRead || uncertain.length || anyUncertain || stageGroupUncertain);
  const failed = !input.topicsCompliant || !input.clickableCompliant ||
    results.some((result) => !result.passed);
  return {
    source: "PERSISTED_RULE_RESULTS",
    status: needsReview ? "NEEDS_REVIEW" : failed ? "NON_COMPLIANT" : "COMPLIANT",
    expectedCount,
    matchedCount,
    required: unique(required),
    matched: unique(matched),
    missing: unique([...missing, ...parseStoredStringArray(input.missingTopics)]),
    forbidden: unique([...forbidden, ...parseStoredStringArray(input.forbiddenTopics)]),
    unclickable: unique(unclickable),
    uncertain: unique(uncertain),
    anyCandidates,
    anyMinimum,
    matchedAnyCandidates,
    unmatchedAnyCandidates,
    anyMissingCount,
    stageCandidates,
    matchedStageCandidates,
    stageGroupMissing,
    stageGroupUnclickable,
    stageGroupUncertain,
    message: technicalRead ? "话题读取证据不完整，需人工复核" : null,
  };
}

function topicFromBoundExtraction(input: PresentationInput): AuditResultPresentationTopic {
  const detected = (input.note.topics || []).map((topic) =>
    normalizeTopic(String(topic.displayText || "")),
  );
  const summary = topicAuditRuleSummary(input.ruleSnapshot, detected);
  const missing = parseStoredStringArray(input.missingTopics);
  const forbidden = parseStoredStringArray(input.forbiddenTopics);
  return {
    source: "RESULT_BOUND_EXTRACTION",
    status: input.topicsCompliant && input.clickableCompliant
      ? "COMPLIANT"
      : "NON_COMPLIANT",
    expectedCount: summary.expectedCount,
    matchedCount: summary.matchedCount,
    required: summary.requiredTopics,
    matched: summary.matchedRequiredTopics,
    missing,
    forbidden,
    unclickable: [],
    uncertain: [],
    anyCandidates: summary.anyCandidates,
    anyMinimum: summary.anyMinimum,
    matchedAnyCandidates: summary.matchedAnyCandidates,
    unmatchedAnyCandidates: summary.unmatchedAnyCandidates,
    anyMissingCount: summary.anyMissingCount,
    stageCandidates: summary.stageCandidates,
    matchedStageCandidates: summary.matchedStageCandidates,
    stageGroupMissing: summary.stageCandidates.length > 0 &&
      summary.matchedStageCandidates.length === 0,
    stageGroupUnclickable: false,
    stageGroupUncertain: false,
    message: null,
  };
}

function unavailableTopic(
  input: PresentationInput,
  source: AuditResultPresentationTopic["source"] = "LEGACY_UNAVAILABLE",
): AuditResultPresentationTopic {
  const expected = topicAuditRuleSummary(input.ruleSnapshot, []).expectedCount;
  return {
    source,
    status: "UNAVAILABLE",
    expectedCount: expected,
    matchedCount: 0,
    required: [],
    matched: [],
    missing: [],
    forbidden: [],
    unclickable: [],
    uncertain: [],
    anyCandidates: [],
    anyMinimum: 0,
    matchedAnyCandidates: [],
    unmatchedAnyCandidates: [],
    anyMissingCount: 0,
    stageCandidates: [],
    matchedStageCandidates: [],
    stageGroupMissing: false,
    stageGroupUnclickable: false,
    stageGroupUncertain: false,
    message: input.evidenceMessage || "历史审核明细不可用，不能使用最新笔记或规则推算。",
  };
}

function automaticLabel(status: string, unavailable: boolean) {
  if (unavailable) return "笔记不存在";
  if (status === "PASSED") return "审核通过";
  if (status === "FAILED") return "审核不通过";
  if (status === "READ_FAILED") return "读取失败";
  if (status === "PROCESSING") return "处理中";
  return "待人工复核";
}

function conclusionTone(status: string, unavailable: boolean): AuditResultPresentationTone {
  if (unavailable) return "neutral";
  if (status === "PASSED") return "success";
  if (status === "FAILED") return "danger";
  return "warning";
}

function reviewSignals(input: PresentationInput, results: PresentationRuleResult[]) {
  const signals: string[] = [];
  if (input.publicStatus === "UNKNOWN") signals.push("公开状态待确认");
  if (input.bodyStatus === "UNKNOWN") signals.push("正文读取结果待确认");
  if (["IMAGES_READ_FAILED", "NOT_CHECKED"].includes(input.imageStatus)) {
    signals.push("图片读取结果待确认");
  }
  if (input.interactionRewardStatus === "PENDING") signals.push("互动奖励待确认");
  if (!signals.length && results.some((result) => result.ruleKey !== "GLOBAL_RETENTION" &&
    /需人工确认|待人工复核|待验证|无法确认/u.test(
      `${result.actualValue} ${result.failureReason || ""} ${result.evidence}`,
    ),
  )) {
    signals.push("审核证据存在待确认项");
  }
  return [...new Set(signals)];
}

function imageLabel(input: PresentationInput) {
  if (["VIDEO", "VIDEO_NOTE"].includes(input.imageStatus)) return "视频笔记，不参与图片数量审核";
  if (input.imageStatus === "COMPLIANT") return "数量合规";
  if (input.imageStatus === "NON_COMPLIANT") return "数量不足";
  if (input.imageStatus === "NOT_REQUIRED") return "无需审核";
  return "待人工复核";
}

function mediaPresentation(input: PresentationInput): AuditResultPresentation["media"] {
  const resultBoundKinds = input.evidenceStatus === "RESULT_BOUND"
    ? [input.note.noteType, input.note.pageType, input.task.pageType,
        input.note.imageExtractionStatus]
    : [];
  const immutableKinds = [
    input.noteType,
    input.imageExtractionStatus,
    ...resultBoundKinds,
  ].map((value) => String(value ?? "").trim().toUpperCase());
  const video = immutableKinds.some((value) =>
    ["VIDEO", "VIDEO_NOTE", "VIDEO_DETAIL"].includes(value),
  );
  if (video) {
    return {
      kind: "VIDEO",
      label: "视频作品",
      imageAuditApplicable: false,
      imageCount: null,
    };
  }
  const imageText = immutableKinds.some((value) =>
    ["IMAGE_TEXT", "IMAGE_TEXT_DETAIL", "NOTE", "NOTE_DETAIL"].includes(value),
  );
  if (imageText) {
    return {
      kind: "IMAGE_TEXT",
      label: "图文作品",
      imageAuditApplicable: true,
      imageCount: typeof input.imageCount === "number" ? input.imageCount : null,
    };
  }
  return {
    kind: "UNKNOWN",
    label: "作品类型无法确认",
    imageAuditApplicable: false,
    imageCount: null,
  };
}

/**
 * The sole projection for list, detail and export. It only reads immutable
 * persisted result fields, result-bound extraction evidence and result-bound
 * rule results; it never reads current rules or a latest Note projection.
 */
export function buildAuditResultPresentation(
  input: PresentationInput,
): AuditResultPresentation {
  const scoped = storeTopicScopedPresentationInput(input);
  const presentationInput = scoped.input;
  const results = scoped.results;
  const topicResults = results.filter((result) => result.ruleKey.startsWith("TOPIC_"));
  const unavailable = isUnavailableNoteResult(presentationInput);
  const processingTopicUnavailable = topicResults.length === 0 && Boolean(
    presentationInput.task.failureCode || presentationInput.task.failureMessage,
  );
  const topic = unavailable
    ? { ...unavailableTopic(presentationInput), message: "页面不可用，本次未执行话题审核。" }
    : processingTopicUnavailable
      ? {
          ...unavailableTopic(presentationInput, "RESULT_BOUND_EXTRACTION"),
          message: "本次审核未形成可确认的话题规则明细，需人工复核或重新审核。",
        }
    : completePersistedTopicEvidence(presentationInput.ruleSnapshot, topicResults)
      ? topicFromPersistedResults(presentationInput, topicResults)
      : presentationInput.evidenceStatus === "RESULT_BOUND"
        ? topicFromBoundExtraction(presentationInput)
        : unavailableTopic(presentationInput);
  const duplicate = duplicateReauditMetadataFromNotes(presentationInput.task.notes);
  const legacyDuplicate = legacyZeroHistoryDuplicateMetadataFromNotes(presentationInput.task.notes);
  const persistedAutomaticStatus = duplicate?.automaticResult ||
    legacyDuplicate?.automaticResult || presentationInput.autoStatus;
  const classificationInput = {
    ...presentationInput,
    autoStatus: persistedAutomaticStatus,
    ruleResults: results,
  };
  const automaticStatus = deriveAuditBusinessStatus(classificationInput);
  const persistedContradiction = persistedAutomaticStatus === "PASSED" && (
    !presentationInput.bodyCompliant || presentationInput.imageCompliant === false ||
    !presentationInput.topicsCompliant || !presentationInput.clickableCompliant ||
    presentationInput.pageStatus !== "NORMAL" ||
    presentationInput.publicStatus === "NOT_PUBLIC" ||
    presentationInput.storeTopicStatus === "NON_COMPLIANT" ||
    results.some(isFailedMandatoryResult)
  );
  const baseReasons = auditConclusionFailureReasons(presentationInput).filter(
    (reason) => !/^(?:公开)?留存|留存期限/u.test(reason),
  );
  const reviewReasons = retentionReviewReasons(classificationInput);
  const derivedReviewSignals = automaticStatus === "NEEDS_REVIEW"
    ? [...new Set([...reviewSignals(presentationInput, results), ...reviewReasons])]
    : [];
  const missingReviewSignal = automaticStatus === "NEEDS_REVIEW" &&
    !baseReasons.length && !derivedReviewSignals.length && !duplicate;
  const legacyIncomplete = !unavailable && topic.source === "LEGACY_UNAVAILABLE";
  const consistencyStatus: AuditResultConsistencyStatus = persistedContradiction || missingReviewSignal
    ? "RESULT_CONSISTENCY_VIOLATION"
    : legacyIncomplete
      ? "HISTORICAL_LEGACY_INCOMPLETE"
      : "CONSISTENT";
  const consistencyMessage = persistedContradiction
    ? "该历史结果的自动结论与当次审核明细不一致，请重新审核。"
    : missingReviewSignal
      ? "该历史结果保存为待人工复核，但未保存可识别的复核信号，请重新审核。"
      : legacyIncomplete
        ? "历史审核明细不可用；保留原保存结论，但不使用最新笔记或规则推算。"
        : null;
  const effectiveAutomaticStatus = consistencyStatus === "RESULT_CONSISTENCY_VIOLATION"
    ? "NEEDS_REVIEW"
    : automaticStatus;
  const automaticConclusion = {
    status: effectiveAutomaticStatus,
    label: consistencyStatus === "RESULT_CONSISTENCY_VIOLATION"
      ? "结果一致性异常"
      : automaticLabel(effectiveAutomaticStatus, unavailable),
    tone: consistencyStatus === "RESULT_CONSISTENCY_VIOLATION"
      ? "warning" as const
      : conclusionTone(effectiveAutomaticStatus, unavailable),
  };
  const manual = input.manualReviews?.[0];
  const conclusion = manual
    ? {
        status: manual.result,
        label: manual.result === "PASSED" ? "人工通过" : "人工不通过",
        tone: manual.result === "PASSED" ? "success" as const : "danger" as const,
        source: "MANUAL" as const,
      }
    : { ...automaticConclusion, source: "AUTOMATIC" as const };
  const failureReasons = [...new Set([
    ...baseReasons,
    ...(consistencyMessage ? [consistencyMessage] : []),
  ])];
  const pendingReasons: string[] = [];
  const retentionDays = retentionDaysFromRuleSnapshot(presentationInput.ruleSnapshot);
  const publicLabel = presentationInput.publicStatus === "PUBLIC"
    ? "当前公开"
    : presentationInput.publicStatus === "NOT_PUBLIC"
      ? "当前不公开"
      : presentationInput.publicStatus === "UNKNOWN"
        ? "无法确认"
        : "不要求";
  const media = mediaPresentation(presentationInput);
  const normalizedImage = media.kind === "VIDEO"
    ? {
        status: "VIDEO_NOTE",
        compliant: null,
        label: "视频作品，不参与图片数量审核",
      }
    : media.kind === "UNKNOWN"
      ? {
          status: "NOT_CHECKED",
          compliant: null,
          label: unavailable ? "未审核" : "作品类型无法确认",
        }
      : {
          status: presentationInput.imageStatus,
          compliant: presentationInput.imageCompliant,
          label: unavailable ? "未审核" : imageLabel(presentationInput),
        };

  return {
    source: "PERSISTED_AUDIT_RESULT",
    consistency: {
      status: consistencyStatus,
      code: consistencyStatus === "CONSISTENT" ? null : consistencyStatus,
      message: consistencyMessage,
    },
    automaticConclusion,
    conclusion,
    failureReasons,
    reviewReasons: automaticStatus === "NEEDS_REVIEW"
      ? derivedReviewSignals
      : [],
    pendingReasons,
    isManualReviewRequired: automaticStatus === "NEEDS_REVIEW" && !manual,
    isPendingRetention: false,
    publicDisplay: { status: presentationInput.publicStatus, label: publicLabel },
    retentionDisplay: {
      status: presentationInput.retentionStatus,
      label: retentionDays > 0 ? "仅作活动信息" : "不要求",
      requirementDays: retentionDays,
      dueAt: null,
    },
    storeTopic: {
      applicable: scoped.applicable,
      status: scoped.applicable
        ? presentationInput.storeTopicStatus || "NOT_CHECKED"
        : "NOT_APPLICABLE",
      label: scoped.applicable ? "适用" : "不适用",
    },
    topic,
    body: {
      status: presentationInput.bodyStatus,
      compliant: presentationInput.bodyCompliant,
      label: unavailable
        ? "未审核"
        : presentationInput.bodyStatus === "UNKNOWN"
        ? "待人工确认"
        : presentationInput.bodyCompliant ? "合规" : "不合规",
    },
    media,
    image: {
      ...normalizedImage,
      minimumCount: minimumImageCountFromRuleSnapshot(presentationInput.ruleSnapshot),
    },
    interactionReward: {
      status: presentationInput.interactionRewardStatus || "NOT_ENABLED",
      likeCount: presentationInput.likeCount ?? null,
      commentCount: presentationInput.commentCount ?? null,
      favoriteCount: presentationInput.favoriteCount ?? null,
      total: presentationInput.interactionTotal ?? null,
      threshold: presentationInput.interactionRewardThreshold ?? null,
    },
  };
}

export function withAuditResultPresentation<T extends PresentationInput>(input: T) {
  return { ...input, presentation: buildAuditResultPresentation(input) };
}

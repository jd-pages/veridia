import { filterAuditDetailReasons } from "@/lib/audit-detail-visibility";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { parseStoredStringArray } from "@/lib/stored-json";
import { normalizeTopic } from "@/lib/topic";
import { topicAuditRuleSummary } from "@/lib/topic-audit-summary";

interface DetailPresentationInput {
  autoStatus: string;
  failureReasons: string;
  missingTopics?: string;
  ruleSnapshot?: string;
  effectiveBodyLength?: number | null;
  imageCount?: number | null;
  pageStatus?: unknown;
  noteType?: unknown;
  note?: {
    title?: unknown;
    body?: unknown;
    topics?: Array<{ displayText?: unknown }>;
  } | null;
  task?: {
    failureCode?: unknown;
    failureMessage?: string | null;
    pageTitle?: unknown;
    pageType?: unknown;
  } | null;
  manualReviews?: Array<{ result: string }>;
}

const technicalStatePattern =
  /\b(?:ERROR_PAGE|APP_LAUNCH|NOTE_DETAIL|NOTE_NOT_FOUND|PAGE_NOT_FOUND|NOTE_DELETED|PAGE_UNAVAILABLE|NOT_FOUND|NOT_ACCESSIBLE|READ_FAILED)\b/iu;

function normalizeFailureReason(
  reason: string,
  input: DetailPresentationInput,
) {
  const topicSummary = topicAuditRuleSummary(
    input.ruleSnapshot,
    (input.note?.topics || []).map((topic) =>
      String(topic.displayText || ""),
    ),
  );
  const stageMatch = reason.match(
    /(?:IFFO|GUM)?\s*阶段话题未命中[：:]\s*(.+?)(?:\s*中至少出现\s*1\s*个)?$/u,
  );
  if (stageMatch) {
    const candidates = topicSummary.stageCandidates.length
      ? topicSummary.stageCandidates
      : stageMatch[1]
      .split(/[、/]/u)
      .map((item) => item.trim())
      .filter(Boolean);
    return `阶段话题未命中：${candidates.join(" / ")}，需任意命中 1 个`;
  }

  const imageCompactMatch = reason.match(
    /图片数量不足[（(]\s*(\d+)\s*[/／]\s*(\d+)\s*[）)]/u,
  );
  if (imageCompactMatch) {
    return `图片数量不足：当前 ${imageCompactMatch[1]} 张，要求 ≥${imageCompactMatch[2]} 张`;
  }

  const imageVerboseMatch = reason.match(
    /图片数量不足[：:]\s*要求至少\s*(\d+)\s*张[，,]\s*实际\s*(\d+)\s*张/u,
  );
  if (imageVerboseMatch) {
    return `图片数量不足：当前 ${imageVerboseMatch[2]} 张，要求 ≥${imageVerboseMatch[1]} 张`;
  }

  const bodyCompactMatch = reason.match(
    /有效正文字数不足[（(]\s*(\d+)\s*[/／]\s*(\d+)\s*[）)]/u,
  );
  if (bodyCompactMatch) {
    return `正文字数不足：当前 ${bodyCompactMatch[1]} 字，要求 ≥${bodyCompactMatch[2]} 字`;
  }

  const bodyVerboseMatch = reason.match(
    /有效正文字数不足[：:]\s*要求至少\s*(\d+)\s*个[，,]\s*实际\s*(\d+)\s*个/u,
  );
  if (bodyVerboseMatch) {
    return `正文字数不足：当前 ${bodyVerboseMatch[2]} 字，要求 ≥${bodyVerboseMatch[1]} 字`;
  }

  const exactTopicMatch = reason.match(/^缺少(?:精确|精准)话题\s*[：:]?\s*(#\S+)$/u);
  if (exactTopicMatch) {
    return `缺少必带话题：${exactTopicMatch[1]}`;
  }

  const anyTopicMatch = reason.match(/任意话题命中不足\s*(\d+)\s*个/u);
  if (anyTopicMatch) {
    if (topicSummary.anyCandidates.length) {
      return `热门话题不足：需 ${topicSummary.anyCandidates.length} 选 ${topicSummary.anyMinimum}，当前命中 ${topicSummary.matchedAnyCandidates.length} 个，还需任意 ${topicSummary.anyMissingCount} 个；已命中：${topicSummary.matchedAnyCandidates.join("、") || "无"}；未命中候选：${topicSummary.unmatchedAnyCandidates.join("、") || "无"}`;
    }
  }

  return reason
    .replace(/[（(](?:任一命中|任选其一)[）)]/gu, "")
    .trim();
}

function unavailableReason(input: DetailPresentationInput) {
  const candidates = [
    ...parseStoredStringArray(input.failureReasons).filter((value) =>
      /无法访问|不见了|不存在|无权|失效|404|已删除|无法浏览|无法查看/u.test(
        value,
      ),
    ),
    input.task?.failureMessage,
    input.task?.pageTitle,
    input.note?.title,
  ]
    .map((value) => String(value || "").trim())
    .filter(
      (value) =>
        value &&
        !technicalStatePattern.test(value) &&
        /无法访问|不见了|不存在|无权|失效|404|已删除|无法浏览|无法查看/u.test(
          value,
        ) &&
        !/^(?:笔记不存在|页面无法访问)$/u.test(value),
    );
  return candidates.length
    ? candidates[0]
    : "小红书页面提示“你访问的页面不见了”";
}

export function auditConclusionCardLabel(input: DetailPresentationInput) {
  if (isUnavailableNoteResult(input)) return "笔记不存在";
  const status = input.manualReviews?.[0]?.result || input.autoStatus;
  if (status === "PASSED") return input.manualReviews?.length
    ? "人工通过"
    : "审核通过";
  if (status === "FAILED") return input.manualReviews?.length
    ? "人工不通过"
    : "审核不通过";
  if (status === "PROCESSING") return "处理中";
  return "待人工复核";
}

export function auditConclusionCardTone(input: DetailPresentationInput) {
  const label = auditConclusionCardLabel(input);
  if (label === "笔记不存在") return "neutral";
  if (label.includes("通过") && !label.includes("不通过")) return "success";
  if (label === "审核不通过" || label === "人工不通过") {
    return "danger";
  }
  return "warning";
}

export function auditConclusionFailureReasons(
  input: DetailPresentationInput,
) {
  if (isUnavailableNoteResult(input)) return [unavailableReason(input)];

  const storedReasons = parseStoredStringArray(input.failureReasons).filter(
    (reason) => !technicalStatePattern.test(reason),
  );
  const fallback =
    storedReasons.length ||
    !input.task?.failureMessage ||
    technicalStatePattern.test(input.task.failureMessage)
      ? []
      : [input.task.failureMessage];
  const reasons = filterAuditDetailReasons([...storedReasons, ...fallback])
    .map((reason) => normalizeFailureReason(reason, input))
    .filter(Boolean);
  const uniqueReasons = [...new Set(reasons)];
  const exactReasonIndexes = uniqueReasons
    .map((reason, index) => reason.startsWith("缺少必带话题：") ? index : -1)
    .filter((index) => index >= 0);
  if (!exactReasonIndexes.length) return uniqueReasons;

  const topicSummary = topicAuditRuleSummary(
    input.ruleSnapshot,
    (input.note?.topics || []).map((topic) => String(topic.displayText || "")),
  );
  const snapshotRequired = new Set(topicSummary.requiredTopics);
  const storedMissing = parseStoredStringArray(input.missingTopics).filter(
    (topic) => snapshotRequired.has(normalizeTopic(topic)),
  );
  const reasonMissing = exactReasonIndexes.flatMap((index) =>
    uniqueReasons[index]
      .replace(/^缺少必带话题：/u, "")
      .split(/[、/]/u)
      .map((topic) => topic.trim())
      .filter(Boolean),
  );
  const missing = [...new Set([...storedMissing, ...reasonMissing].map(normalizeTopic))];
  return uniqueReasons.flatMap((reason, index) => {
    if (index === exactReasonIndexes[0]) {
      return [`缺少必带话题：${missing.join(" / ")}`];
    }
    return exactReasonIndexes.includes(index) ? [] : [reason];
  });
}

export function minimumImageCountFromRuleSnapshot(ruleSnapshot: string) {
  try {
    const parsed = JSON.parse(ruleSnapshot) as { minImageCount?: unknown };
    return typeof parsed.minImageCount === "number" &&
      Number.isFinite(parsed.minImageCount)
      ? parsed.minImageCount
      : null;
  } catch {
    return null;
  }
}

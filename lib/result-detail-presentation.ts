import { filterAuditDetailReasons } from "@/lib/audit-detail-visibility";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { parseStoredStringArray } from "@/lib/stored-json";
import { normalizeTopic } from "@/lib/topic";

interface DetailPresentationInput {
  autoStatus: string;
  failureReasons: string;
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

interface RuleSnapshotForPresentation {
  minBodyLength?: number;
  minImageCount?: number;
  rules?: Array<{
    ruleType?: string;
    topicCategory?: string;
    topic?: string;
    minCount?: number;
  }>;
}

const technicalStatePattern =
  /\b(?:ERROR_PAGE|APP_LAUNCH|NOTE_DETAIL|NOTE_NOT_FOUND|PAGE_NOT_FOUND|NOTE_DELETED|PAGE_UNAVAILABLE|NOT_FOUND|NOT_ACCESSIBLE|READ_FAILED)\b/iu;

function ruleSnapshotForPresentation(value?: string) {
  try {
    return JSON.parse(value || "{}") as RuleSnapshotForPresentation;
  } catch {
    return {};
  }
}

function normalizeFailureReason(
  reason: string,
  input: DetailPresentationInput,
) {
  const snapshot = ruleSnapshotForPresentation(input.ruleSnapshot);
  const stageMatch = reason.match(
    /(?:IFFO|GUM)?\s*阶段话题未命中[：:]\s*(.+?)(?:\s*中至少出现\s*1\s*个)?$/u,
  );
  if (stageMatch) {
    const candidates = stageMatch[1]
      .split(/[、/]/u)
      .map((item) => item.trim())
      .filter(Boolean);
    return `阶段话题未命中：${candidates.join(" / ")}`;
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
    const anyRules = (snapshot.rules || []).filter(
      (rule) =>
        rule.ruleType === "ANY" && rule.topicCategory !== "PRODUCT_STAGE",
    );
    const minimum = Math.max(
      Number(anyTopicMatch[1]),
      ...anyRules.map((rule) => Number(rule.minCount || 0)),
    );
    const detected = new Set(
      (input.note?.topics || []).map((topic) =>
        normalizeTopic(String(topic.displayText || "")),
      ),
    );
    const matched = anyRules.filter((rule) =>
      detected.has(normalizeTopic(String(rule.topic || ""))),
    ).length;
    if (anyRules.length) {
      return `热门话题不足：需 ${anyRules.length} 选 ${minimum}，当前命中 ${matched} 个，缺 ${Math.max(0, minimum - matched)} 个`;
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
  return [...new Set(reasons)];
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

import { filterAuditDetailReasons } from "@/lib/audit-detail-visibility";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { parseStoredStringArray } from "@/lib/stored-json";

interface DetailPresentationInput {
  autoStatus: string;
  failureReasons: string;
  ruleSnapshot: string;
  pageStatus?: unknown;
  noteType?: unknown;
  note?: {
    title?: unknown;
    body?: unknown;
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
  /\b(?:ERROR_PAGE|APP_LAUNCH|NOTE_DETAIL|PAGE_NOT_FOUND|NOTE_DELETED|PAGE_UNAVAILABLE|NOT_FOUND|NOT_ACCESSIBLE|READ_FAILED)\b/iu;

function normalizeFailureReason(reason: string) {
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
    return `图片不足：当前 ${imageCompactMatch[1]} 张，要求至少 ${imageCompactMatch[2]} 张`;
  }

  const imageVerboseMatch = reason.match(
    /图片数量不足[：:]\s*要求至少\s*(\d+)\s*张[，,]\s*实际\s*(\d+)\s*张/u,
  );
  if (imageVerboseMatch) {
    return `图片不足：当前 ${imageVerboseMatch[2]} 张，要求至少 ${imageVerboseMatch[1]} 张`;
  }

  return reason
    .replace(/^缺少精确话题\s*/u, "缺少精准话题：")
    .replace(/[（(](?:任一命中|任选其一)[）)]/gu, "")
    .trim();
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
  if (label.includes("通过") && !label.includes("不通过")) return "success";
  if (label === "审核不通过" || label === "人工不通过" || label === "笔记不存在") {
    return "danger";
  }
  return "warning";
}

export function auditConclusionFailureReasons(
  input: DetailPresentationInput,
) {
  if (isUnavailableNoteResult(input)) return ["笔记不存在"];

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
    .map(normalizeFailureReason)
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

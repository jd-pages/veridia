export interface AuditResultDisplayInput {
  pageStatus?: unknown;
  errorCode?: unknown;
  category?: unknown;
  failureReason?: unknown;
  failureReasons?: unknown;
  pageTitle?: unknown;
  pageContent?: unknown;
  noteType?: unknown;
  note?: {
    title?: unknown;
    body?: unknown;
  } | null;
  task?: {
    failureCode?: unknown;
    failureMessage?: unknown;
    pageTitle?: unknown;
    pageType?: unknown;
  } | null;
}

export const unavailableNoteListDisplay = {
  contentStatus: "笔记不存在",
  topicAudit: "未审核",
  imageStatus: "未审核",
  auditConclusion: "笔记不存在",
} as const;

const unavailableStates = new Set([
  "NOTE_NOT_FOUND",
  "PAGE_NOT_FOUND",
  "NOTE_DELETED",
  "PAGE_UNAVAILABLE",
  "ERROR_PAGE",
  "NOT_FOUND",
  "NOT_ACCESSIBLE",
  // 当前持久化 pageStatus 对 NOTE_DELETED 使用 DELETED。
  "DELETED",
]);

const unavailableTitlePattern =
  /小红书\s*-\s*你访问的页面不见了|错误页|你访问的页面不见了/u;
const unavailablePageContentPattern =
  /你访问的页面不见了|页面不存在|笔记不存在|笔记已删除|当前笔记无法浏览|该内容无法查看|内容已被删除/u;
const unavailableFailurePattern =
  /你访问的页面不见了|页面不存在|笔记不存在|笔记已删除|该内容无法查看|内容已被删除/u;
const unavailableReasonMatchPattern =
  /你访问的页面不见了|笔记已删除|内容已被删除|页面不存在|笔记不存在|该内容无法查看|当前笔记无法浏览|错误页/u;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedState(value: unknown) {
  return text(value).toUpperCase();
}

function stateValues(result: AuditResultDisplayInput) {
  return [
    result.pageStatus,
    result.errorCode,
    result.category,
    result.noteType,
    result.task?.failureCode,
    result.task?.pageType,
  ].map(normalizedState);
}

function titleValues(result: AuditResultDisplayInput) {
  return [
    result.pageTitle,
    result.note?.title,
    result.task?.pageTitle,
  ].map(text);
}

function pageContentValues(result: AuditResultDisplayInput) {
  return [result.pageContent, result.note?.body].map(text);
}

function failureValues(result: AuditResultDisplayInput) {
  return [
    result.failureReason,
    result.failureReasons,
    result.task?.failureMessage,
  ].map(text);
}

export function isUnavailableNoteResult(result: AuditResultDisplayInput) {
  return (
    stateValues(result).some((value) => unavailableStates.has(value)) ||
    titleValues(result).some((value) => unavailableTitlePattern.test(value)) ||
    pageContentValues(result).some((value) =>
      unavailablePageContentPattern.test(value),
    ) ||
    failureValues(result).some((value) =>
      unavailableFailurePattern.test(value),
    )
  );
}

export function auditResultListDisplay(result: AuditResultDisplayInput) {
  return isUnavailableNoteResult(result)
    ? unavailableNoteListDisplay
    : null;
}

function inferredUnavailableReasonText(result: AuditResultDisplayInput) {
  const evidenceValues = [
    ...titleValues(result),
    ...pageContentValues(result),
    ...failureValues(result),
  ];
  for (const value of evidenceValues) {
    const match = value.match(unavailableReasonMatchPattern)?.[0];
    if (match) return match;
  }

  const states = stateValues(result);
  if (states.some((value) => ["NOTE_DELETED", "DELETED"].includes(value))) {
    return "笔记已删除";
  }
  if (states.includes("ERROR_PAGE")) return "错误页";
  if (states.includes("NOT_ACCESSIBLE")) return "该内容无法查看";
  return "页面不存在";
}

export function unavailableNoteDetailReason(
  result: AuditResultDisplayInput,
) {
  const matchedText = inferredUnavailableReasonText(result);
  return `小红书页面提示“${matchedText}”`;
}

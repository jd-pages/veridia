import { parseXhsPublishedAtText } from "@/lib/platform-published-at";
import { deriveXhsNoteIdCreationTime } from "@/lib/xhs-original-published-at";

interface ResultBoundPublishedAt {
  evidenceStatus?: "RESULT_BOUND" | "LEGACY_UNAVAILABLE";
  publishedAt: unknown;
  publishedAtRaw?: unknown;
  publishedAtSource?: unknown;
}

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function validCalendarDate(year: number, month: number, day: number) {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function absolutePublishedAt(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (dateOnly) {
    return validCalendarDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))
      ? new Date(`${value}T00:00:00.000Z`) : null;
  }
  // Zone-less or relative strings cannot be interpreted using server time.
  const zonedTimestamp = value.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/iu);
  if (!zonedTimestamp || !validCalendarDate(
    Number(zonedTimestamp[1]), Number(zonedTimestamp[2]), Number(zonedTimestamp[3]),
  )) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A result-bound business date; it neither reads current state nor schedules a task. */
export function resultBoundNextReviewDate(input: ResultBoundPublishedAt, days: 15 | 30 = 30): Date | null {
  if (input.evidenceStatus !== "RESULT_BOUND") return null;
  const source = typeof input.publishedAtSource === "string"
    ? input.publishedAtSource.trim() : "";
  if (!source || /NOTE[_ -]?ID|DERIVED/iu.test(source)) return null;
  const sources = source.split("|").map((part) => part.trim());
  const structured = sources.some((part) =>
    /^(?:NETWORK_JSON|PAGE_JSON|DOUYIN_STRUCTURED)(?::|$)/u.test(part),
  );
  const displayed = sources.some((part) =>
    /^(?:DOM_MAIN_NOTE|DOUYIN_DOM_CURRENT_DETAIL)(?::|$)/u.test(part),
  );
  if (!structured && !displayed) return null;
  if (!structured) {
    const raw = typeof input.publishedAtRaw === "string"
      ? input.publishedAtRaw.replace(/^\s*发布时间[：:]\s*/u, "") : "";
    // A stored Date alone cannot prove a year omitted by the platform DOM.
    const displayedEvidence = parseXhsPublishedAtText(raw, source, null);
    if (!displayedEvidence?.value) return null;
  }
  const publishedAt = absolutePublishedAt(input.publishedAt);
  if (!publishedAt) return null;
  return shanghaiPlusDays(publishedAt, days);
}

function shanghaiPlusDays(publishedAt: Date, days: 15 | 30) {
  const parts = Object.fromEntries(
    shanghaiDateFormatter.formatToParts(publishedAt)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  // Excel Date cells encode the business calendar date at UTC midnight.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
}

/** Presentation only. Estimated dates are never publication or retention evidence.
 * Keep resultBoundNextReviewDate as the sole trusted-date entry for automation. */
export function resultBoundManualReviewDate(input: ResultBoundPublishedAt & {
  contentChannel?: unknown;
  platformNoteId?: unknown;
  noteUrl?: unknown;
  originalUrl?: unknown;
  finalUrl?: unknown;
  capturedAt?: unknown;
}, now = new Date(), days: 15 | 30 = 30) {
  const confirmed = resultBoundNextReviewDate(input, days);
  if (confirmed) return { date: confirmed, estimated: false, noteId: null,
    reason: `当次采集快照中的可信笔记发布日期，加${days}个北京时间自然日` };
  const unavailable = { date: null, estimated: false, noteId: null,
    reason: "缺少可信原始发布时间或当次绑定且身份一致的有效小红书笔记ID" };
  if (input.evidenceStatus !== "RESULT_BOUND" || input.contentChannel !== "XIAOHONGSHU") return unavailable;
  const ids = new Set<string>();
  if (input.platformNoteId != null && input.platformNoteId !== "") {
    if (typeof input.platformNoteId !== "string" || !/^[0-9a-f]{24}$/iu.test(input.platformNoteId.trim())) return unavailable;
    ids.add(input.platformNoteId.trim().toLowerCase());
  }
  for (const value of [input.noteUrl, input.originalUrl, input.finalUrl]) {
    if (typeof value !== "string" || !value.trim()) continue;
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      !["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname.toLowerCase())) continue;
    const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([^/]+)\/?$/u);
    if (!match) continue;
    if (!/^[0-9a-f]{24}$/iu.test(match[1])) return unavailable;
    ids.add(match[1].toLowerCase());
  }
  if (ids.size !== 1) return unavailable;
  const noteId = [...ids][0];
  const anchor = input.capturedAt == null ? now : absolutePublishedAt(input.capturedAt);
  if (!anchor || anchor.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return unavailable;
  const created = deriveXhsNoteIdCreationTime(noteId, anchor);
  if (!created) return unavailable;
  return { date: shanghaiPlusDays(created, days), estimated: true, noteId,
    reason: `预计日期（笔记ID推算）：当次绑定小红书笔记ID ${noteId} 的创建时间 ${created.toISOString()} 加${days}个北京时间自然日；仅供人工安排复查，不是平台确认的发布时间，不证明留存或打款资格，不触发自动复核。` };
}

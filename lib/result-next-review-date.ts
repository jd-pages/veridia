import { parseXhsPublishedAtText } from "@/lib/platform-published-at";

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
export function resultBoundNextReviewDate(input: ResultBoundPublishedAt): Date | null {
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
  const parts = Object.fromEntries(
    shanghaiDateFormatter.formatToParts(publishedAt)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  // Excel Date cells encode the business calendar date at UTC midnight.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 30));
}

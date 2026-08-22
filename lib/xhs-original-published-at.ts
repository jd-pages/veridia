import { formatShanghaiDateTime } from "@/lib/platform-published-at";

export const XHS_NOTE_ID_DERIVED_CREATION_TIME =
  "XHS_NOTE_ID_DERIVED_CREATION_TIME" as const;
export const STRUCTURED_PUBLISHED_TIME = "STRUCTURED_PUBLISHED_TIME" as const;
export const PUBLISHED_TIME_CONFLICT = "PUBLISHED_TIME_CONFLICT" as const;

const EARLIEST_XHS_TIME_MS = Date.parse("2013-01-01T00:00:00.000Z");
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;
const STRUCTURED_MATCH_TOLERANCE_MS = 5 * 60 * 1_000;
const XHS_CHANNEL_VALUES = new Set(["XIAOHONGSHU", "XHS", "小红书"]);

export type OriginalPublishedAtSource =
  | typeof STRUCTURED_PUBLISHED_TIME
  | typeof XHS_NOTE_ID_DERIVED_CREATION_TIME;

export interface OriginalPublishedAtPresentation {
  originalPublishedAt: string | null;
  originalPublishedAtStatus: "CONFIRMED" | "UNCONFIRMED" | "CONFLICT";
  originalPublishedAtSource: OriginalPublishedAtSource | null;
  originalPublishedAtCode: typeof PUBLISHED_TIME_CONFLICT | null;
  originalPublishedAtEvidence: {
    structuredPublishedAt: string | null;
    noteIdDerivedCreationTime: string | null;
    differenceSeconds: number | null;
  };
}

function validDate(input: unknown) {
  if (!input) return null;
  const value = input instanceof Date ? new Date(input.getTime()) : new Date(String(input));
  return Number.isNaN(value.getTime()) ? null : value;
}

export function deriveXhsNoteIdCreationTime(
  platformNoteId: unknown,
  now: Date = new Date(),
) {
  const noteId = typeof platformNoteId === "string" ? platformNoteId.trim() : "";
  if (!/^[0-9a-fA-F]{24}$/u.test(noteId)) return null;

  const unixSeconds = Number.parseInt(noteId.slice(0, 8), 16);
  const derived = new Date(unixSeconds * 1_000);
  const nowValue = validDate(now);
  if (
    !nowValue ||
    derived.getTime() < EARLIEST_XHS_TIME_MS ||
    derived.getTime() > nowValue.getTime() + MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return derived;
}

export function isStructuredXhsPublishedAtSource(source: unknown) {
  const value = typeof source === "string" ? source : "";
  return value
    .split("|")
    .some((part) => /^(?:NETWORK_JSON|PAGE_JSON)(?::|$)/u.test(part.trim()));
}

export function resolveXhsOriginalPublishedAt(input: {
  platformNoteId?: unknown;
  publishedAt?: unknown;
  publishedAtSource?: unknown;
  now?: Date;
}): OriginalPublishedAtPresentation {
  const derived = deriveXhsNoteIdCreationTime(
    input.platformNoteId,
    input.now ?? new Date(),
  );
  const structured = isStructuredXhsPublishedAtSource(input.publishedAtSource)
    ? validDate(input.publishedAt)
    : null;
  const differenceSeconds = structured && derived
    ? Math.abs(structured.getTime() - derived.getTime()) / 1_000
    : null;
  const evidence = {
    structuredPublishedAt: structured?.toISOString() ?? null,
    noteIdDerivedCreationTime: derived?.toISOString() ?? null,
    differenceSeconds,
  };

  if (
    structured &&
    derived &&
    Math.abs(structured.getTime() - derived.getTime()) >
      STRUCTURED_MATCH_TOLERANCE_MS
  ) {
    return {
      originalPublishedAt: null,
      originalPublishedAtStatus: "CONFLICT",
      originalPublishedAtSource: null,
      originalPublishedAtCode: PUBLISHED_TIME_CONFLICT,
      originalPublishedAtEvidence: evidence,
    };
  }
  if (structured) {
    return {
      originalPublishedAt: structured.toISOString(),
      originalPublishedAtStatus: "CONFIRMED",
      originalPublishedAtSource: STRUCTURED_PUBLISHED_TIME,
      originalPublishedAtCode: null,
      originalPublishedAtEvidence: evidence,
    };
  }
  if (derived) {
    return {
      originalPublishedAt: derived.toISOString(),
      originalPublishedAtStatus: "CONFIRMED",
      originalPublishedAtSource: XHS_NOTE_ID_DERIVED_CREATION_TIME,
      originalPublishedAtCode: null,
      originalPublishedAtEvidence: evidence,
    };
  }
  return {
    originalPublishedAt: null,
    originalPublishedAtStatus: "UNCONFIRMED",
    originalPublishedAtSource: null,
    originalPublishedAtCode: null,
    originalPublishedAtEvidence: evidence,
  };
}

export function originalPublishedAtSourceLabel(
  source: OriginalPublishedAtSource | null,
) {
  if (source === STRUCTURED_PUBLISHED_TIME) return "结构化发布时间";
  if (source === XHS_NOTE_ID_DERIVED_CREATION_TIME) return "Note ID 推导";
  return "未能确认";
}

export function formatOriginalPublishedAt(
  presentation: Pick<
    OriginalPublishedAtPresentation,
    "originalPublishedAt" | "originalPublishedAtStatus"
  >,
) {
  if (presentation.originalPublishedAtStatus === "CONFLICT") return "待确认";
  return presentation.originalPublishedAt
    ? formatShanghaiDateTime(presentation.originalPublishedAt)
    : "未能确认";
}

export function withXhsOriginalPublishedAt<
  T extends {
    note: {
      contentChannel?: unknown;
      platformNoteId?: unknown;
      publishedAt?: unknown;
      publishedAtSource?: unknown;
    };
    task?: { channel?: unknown; platform?: unknown };
  },
>(
  result: T,
  now: Date = new Date(),
): Omit<T, "note"> & {
  note: T["note"] & OriginalPublishedAtPresentation;
} {
  const isXhs = [
    result.note.contentChannel,
    result.task?.channel,
    result.task?.platform,
  ].some((value) => XHS_CHANNEL_VALUES.has(String(value ?? "").trim().toUpperCase()));
  const presentation = isXhs
    ? resolveXhsOriginalPublishedAt({
        platformNoteId: result.note.platformNoteId,
        publishedAt: result.note.publishedAt,
        publishedAtSource: result.note.publishedAtSource,
        now,
      })
    : resolveXhsOriginalPublishedAt({ now });
  return {
    ...result,
    note: {
      ...result.note,
      ...presentation,
    },
  };
}

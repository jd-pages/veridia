import type { AuditEvaluation, ExtractedNote } from "@/lib/types";
import { resolveXhsOriginalPublishedAt } from "@/lib/xhs-original-published-at";

export const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;

function validDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveReliablePublishedAt(
  note: Pick<
    ExtractedNote,
    "contentChannel" | "noteId" | "publishedAt" | "publishedAtSource"
  >,
  now = new Date(),
) {
  if (note.contentChannel === "XIAOHONGSHU") {
    const original = resolveXhsOriginalPublishedAt({
      platformNoteId: note.noteId,
      publishedAt: note.publishedAt,
      publishedAtSource: note.publishedAtSource,
      now,
    });
    return original.originalPublishedAtStatus === "CONFIRMED"
      ? validDate(original.originalPublishedAt)
      : null;
  }
  return validDate(note.publishedAt);
}

export function evaluateRetentionStatus(input: {
  publicStatus: AuditEvaluation["publicStatus"];
  retentionDays: number;
  publishedAt: Date | null;
  now?: Date;
}): Pick<AuditEvaluation, "retentionStatus" | "retentionDueAt"> {
  if (input.retentionDays <= 0) {
    return { retentionStatus: "NOT_REQUIRED", retentionDueAt: null };
  }
  if (input.publicStatus === "NOT_REQUIRED") {
    return { retentionStatus: "NOT_REQUIRED", retentionDueAt: null };
  }
  if (input.publicStatus === "NOT_PUBLIC") {
    return { retentionStatus: "NOT_SATISFIED", retentionDueAt: null };
  }
  if (!input.publishedAt) {
    return { retentionStatus: "UNKNOWN", retentionDueAt: null };
  }
  const dueAt = new Date(
    input.publishedAt.getTime() + input.retentionDays * RETENTION_DAY_MS,
  );
  const retentionDueAt = dueAt.toISOString();
  if (input.publicStatus !== "PUBLIC") {
    return { retentionStatus: "UNKNOWN", retentionDueAt };
  }
  return {
    retentionStatus:
      (input.now ?? new Date()).getTime() >= dueAt.getTime()
        ? "SATISFIED"
        : "PENDING",
    retentionDueAt,
  };
}

export function retentionDaysFromRuleSnapshot(ruleSnapshot: string) {
  try {
    const parsed = JSON.parse(ruleSnapshot) as { retentionDays?: unknown };
    return typeof parsed.retentionDays === "number" &&
      Number.isFinite(parsed.retentionDays)
      ? Math.max(0, parsed.retentionDays)
      : 0;
  } catch {
    return 0;
  }
}

export function resolveRetentionDueAt(input: {
  retentionDueAt?: Date | string | null;
  retentionStatus: string;
  ruleSnapshot: string;
  note: {
    contentChannel?: unknown;
    platformNoteId?: unknown;
    publishedAt?: unknown;
    publishedAtSource?: unknown;
  };
  now?: Date;
}) {
  const persisted = validDate(input.retentionDueAt);
  if (persisted) return persisted.toISOString();
  if (input.retentionStatus !== "PENDING") return null;
  const retentionDays = retentionDaysFromRuleSnapshot(input.ruleSnapshot);
  if (!retentionDays) return null;
  const contentChannel = String(input.note.contentChannel ?? "").toUpperCase();
  const publishedAt = resolveReliablePublishedAt({
    contentChannel: contentChannel === "XIAOHONGSHU"
      ? "XIAOHONGSHU"
      : "DOUYIN",
    noteId: typeof input.note.platformNoteId === "string"
      ? input.note.platformNoteId
      : null,
    publishedAt: validDate(input.note.publishedAt)?.toISOString() ?? null,
    publishedAtSource: typeof input.note.publishedAtSource === "string"
      ? input.note.publishedAtSource
      : null,
  }, input.now);
  return publishedAt
    ? new Date(publishedAt.getTime() + retentionDays * RETENTION_DAY_MS).toISOString()
    : null;
}

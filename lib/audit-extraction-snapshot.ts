import { normalizeDouyinTopicName } from "@/lib/douyin-topic";
import { normalizeTopic } from "@/lib/topic";
import { classifyTopicClickability } from "@/lib/topic-clickability";
import type { AuditEvaluation, ExtractedNote, ExtractedTopic } from "@/lib/types";

export const AUDIT_EXTRACTION_SNAPSHOT_VERSION = 1;
export const LEGACY_EXTRACTION_EVIDENCE_MESSAGE =
  "此历史结果未绑定可确认的当次采集快照；正文、标题、话题和发布时间等原始证据未能确认。已保存的审核结论、规则与互动奖励保持不变。";

/** Store the exact normalized evidence evaluated, without retaining image URLs. */
export function buildAuditExtractionSnapshot(
  payload: ExtractedNote,
  input: {
    contentChannel: "XIAOHONGSHU" | "DOUYIN";
    auditedTopics: ExtractedTopic[];
    publishedAt: Date | null;
    evaluation: Pick<AuditEvaluation, "noteType" | "imageExtractionStatus" | "imageCount">;
    taskStatus?: string;
    failure?: { code: string | null; message: string | null };
  },
) {
  const snapshot = {
    ...payload,
    auditEvidenceVersion: AUDIT_EXTRACTION_SNAPSHOT_VERSION,
    contentChannel: input.contentChannel,
    title: payload.title ?? null,
    body: payload.body ?? null,
    authorName: payload.authorName ?? null,
    finalUrl: payload.finalUrl ?? payload.url,
    noteId: payload.noteId ?? null,
    isPublic: payload.isPublic ?? null,
    publishedAt: input.publishedAt?.toISOString() ?? null,
    publishedAtRaw: payload.pageStatus === "NORMAL" ? payload.publishedAtRaw ?? null : null,
    publishedAtSource: payload.pageStatus === "NORMAL" ? payload.publishedAtSource ?? null : null,
    noteType: input.evaluation.noteType,
    imageExtractionStatus: input.evaluation.imageExtractionStatus,
    imageCount: input.evaluation.imageCount,
    auditTaskEvidence: {
      status: input.taskStatus ?? null,
      // Normal extraction never inherits diagnostics left on a retried task.
      failureCode: input.failure?.code ?? null,
      failureMessage: input.failure?.message ?? null,
      pageTitle: payload.pageTitle ?? payload.title ?? null,
      pageType: payload.pageType ?? null,
    },
    topics: input.auditedTopics.map((topic) => ({
      ...topic,
      normalizedText: input.contentChannel === "DOUYIN"
        ? normalizeDouyinTopicName(topic.displayText)
        : normalizeTopic(topic.displayText),
      isClickable: classifyTopicClickability(topic, {
        pageUrl: payload.finalUrl || payload.url,
      }) === "CLICKABLE",
    })),
  };
  delete snapshot.imageUrls;
  return snapshot;
}

interface BoundExtraction {
  id: string;
  auditTaskId: string | null;
  rawData: string;
  extractedAt: Date;
}

interface SnapshotResult {
  id: string;
  auditTaskId: string;
  extractionRecordId: string | null;
  extractionRecord: BoundExtraction | null;
  auditedAt: Date;
  pageStatus: string;
  noteType: string;
  imageExtractionStatus: string;
  imageCount: number;
  autoStatus: string;
  note: { id: string };
  task: { url: string; finalUrl: string | null; channel: string | null };
}

function readSnapshot(result: SnapshotResult) {
  const extraction = result.extractionRecord;
  if (!extraction || extraction.id !== result.extractionRecordId ||
      extraction.auditTaskId !== result.auditTaskId) return null;
  try {
    const value = JSON.parse(extraction.rawData) as ReturnType<typeof buildAuditExtractionSnapshot>;
    const nullableText = (text: unknown) => text === null || typeof text === "string";
    if (value.auditEvidenceVersion !== AUDIT_EXTRACTION_SNAPSHOT_VERSION ||
        typeof value.url !== "string" || !Array.isArray(value.topics) ||
        !value.topics.every((topic) => typeof topic?.displayText === "string") ||
        typeof value.pageStatus !== "string" ||
        ![value.title, value.body, value.authorName, value.noteId, value.publishedAt,
          value.publishedAtRaw, value.publishedAtSource].every(nullableText) ||
        (value.publishedAt !== null && Number.isNaN(Date.parse(value.publishedAt))) ||
        (value.isPublic !== null && typeof value.isPublic !== "boolean") ||
        (value.imageCount !== null && (!Number.isInteger(value.imageCount) || value.imageCount < 0))) return null;
    return value;
  } catch {
    return null;
  }
}

/** Never use the latest NoteRecord or another extraction as historical evidence. */
export function withAuditExtractionSnapshot<T extends SnapshotResult>(result: T) {
  const snapshot = readSnapshot(result);
  const extraction = snapshot ? result.extractionRecord : null;
  return {
    ...result,
    evidenceStatus: snapshot ? "RESULT_BOUND" as const : "LEGACY_UNAVAILABLE" as const,
    evidenceMessage: snapshot ? null : LEGACY_EXTRACTION_EVIDENCE_MESSAGE,
    // Do not expose a corrupt/unbound record as diagnostic evidence either.
    extractionRecord: extraction,
    task: {
      ...result.task,
      finalUrl: snapshot?.finalUrl ?? null,
      failureCode: snapshot?.auditTaskEvidence?.failureCode ?? null,
      failureMessage: snapshot?.auditTaskEvidence?.failureMessage ?? null,
      pageTitle: snapshot?.auditTaskEvidence?.pageTitle ?? snapshot?.pageTitle ?? snapshot?.title ?? null,
      pageType: snapshot?.auditTaskEvidence?.pageType ?? snapshot?.pageType ?? null,
      failureEvidence: snapshot?.pageEvidence ? JSON.stringify(snapshot.pageEvidence) : null,
      status: snapshot?.auditTaskEvidence?.status ?? (result.autoStatus === "READ_FAILED" ? "READ_FAILED"
        : result.autoStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "COMPLETED"),
    },
    note: {
      id: result.note.id,
      contentChannel: snapshot?.contentChannel ?? result.task.channel,
      platformNoteId: snapshot?.noteId ?? null,
      url: snapshot?.url ?? result.task.url,
      finalUrl: snapshot?.finalUrl ?? null,
      title: snapshot?.title ?? null,
      body: snapshot?.body ?? null,
      authorName: snapshot?.authorName ?? null,
      publishedAt: snapshot?.publishedAt ?? null,
      publishedAtRaw: snapshot?.publishedAtRaw ?? null,
      publishedAtSource: snapshot?.publishedAtSource ?? null,
      pageStatus: snapshot?.pageStatus ?? result.pageStatus,
      isPublic: snapshot?.isPublic ?? null,
      noteType: snapshot?.noteType ?? result.noteType,
      imageExtractionStatus: snapshot?.imageExtractionStatus ?? result.imageExtractionStatus,
      imageCount: snapshot ? snapshot.imageCount : result.imageCount,
      imageUrls: "[]",
      lastCapturedAt: extraction?.extractedAt ?? null,
      topics: snapshot?.topics.map((topic, index) => ({
        ...topic,
        id: `${extraction!.id}:topic:${index}`,
        href: topic.href ?? null,
      })) ?? [],
      extractions: extraction ? [extraction] : [],
    },
  };
}

import { describe, expect, it } from "vitest";
import {
  buildAuditExtractionSnapshot,
  withAuditExtractionSnapshot,
} from "@/lib/audit-extraction-snapshot";
import { createMockNote } from "@/lib/mock-data";

function fixture() {
  const note = {
    ...createMockNote("passed"),
    title: "历史标题 A", body: "历史正文 A", noteId: "historical-note",
    publishedAt: "2026-08-01T00:00:00.000Z", isPublic: true,
    likeCount: 0, commentCount: 4, favoriteCount: 6,
    imageCount: 2, imageUrls: ["https://example.invalid/private-image.jpg"],
  };
  const snapshot = buildAuditExtractionSnapshot(note, {
    contentChannel: "XIAOHONGSHU", auditedTopics: note.topics,
    publishedAt: new Date(note.publishedAt),
    evaluation: { noteType: "IMAGE_TEXT", imageExtractionStatus: "SUCCESS", imageCount: 2 },
  });
  const result = {
    id: "result-a", auditTaskId: "task-a", extractionRecordId: "extraction-a",
    extractionRecord: {
      id: "extraction-a", auditTaskId: "task-a", rawData: JSON.stringify(snapshot),
      extractedAt: new Date("2026-09-08T00:00:00.000Z"),
    },
    auditedAt: new Date("2026-09-08T00:00:01.000Z"),
    pageStatus: "NORMAL", noteType: "IMAGE_TEXT", imageExtractionStatus: "SUCCESS", imageCount: 2,
    autoStatus: "PASSED",
    likeCount: 0, commentCount: 4, favoriteCount: 6, interactionTotal: 10,
    interactionRewardThreshold: 10, interactionRewardStatus: "SATISFIED",
    note: { id: "note-shared", body: null, publishedAt: null, pageStatus: "READ_FAILED", topics: [] },
    task: { url: note.url, finalUrl: note.url, channel: "XIAOHONGSHU" },
  };
  return { note, snapshot, result };
}

describe("HISTORICAL_EXTRACTION_IMMUTABLE", () => {
  it("历史详情仅使用结果绑定快照，不读取最新笔记", () => {
    const { result, snapshot } = fixture();
    const detail = withAuditExtractionSnapshot(result);
    expect(detail.evidenceStatus).toBe("RESULT_BOUND");
    expect(detail.note).toMatchObject({
      title: "历史标题 A", body: "历史正文 A", publishedAt: "2026-08-01T00:00:00.000Z",
      pageStatus: "NORMAL", isPublic: true, imageCount: 2,
    });
    expect(detail.note.topics).toHaveLength(snapshot.topics.length);
    expect(detail.note.extractions.map((entry) => entry.id)).toEqual(["extraction-a"]);
    expect(detail).toMatchObject({ likeCount: 0, interactionTotal: 10, interactionRewardThreshold: 10 });
  });

  it("保存审核规范化的时间与图片元数据，不保留图片 URL", () => {
    const { note } = fixture();
    const snapshot = buildAuditExtractionSnapshot({ ...note, pageStatus: "READ_FAILED" }, {
      contentChannel: "XIAOHONGSHU", auditedTopics: [], publishedAt: null,
      evaluation: { noteType: "UNKNOWN", imageExtractionStatus: "NOT_CHECKED", imageCount: null },
    });
    expect(snapshot).toMatchObject({ publishedAt: null, publishedAtSource: null, imageCount: null, topics: [] });
    expect(snapshot).not.toHaveProperty("imageUrls");
  });

  it.each(["unbound", "invalid-json", "wrong-task", "wrong-record", "unversioned"])(
    "%s 快照不可确认时明确兼容，不回退到最新证据", (kind) => {
      const { result } = fixture();
      if (kind === "unbound") result.extractionRecordId = "missing";
      if (kind === "invalid-json") result.extractionRecord.rawData = "{";
      if (kind === "wrong-task") result.extractionRecord.auditTaskId = "another-task";
      if (kind === "wrong-record") result.extractionRecord.id = "another-record";
      if (kind === "unversioned") result.extractionRecord.rawData = JSON.stringify(createMockNote("passed"));
      const detail = withAuditExtractionSnapshot(result);
      expect(detail.evidenceStatus).toBe("LEGACY_UNAVAILABLE");
      expect(detail.note).toMatchObject({ title: null, body: null, publishedAt: null, platformNoteId: null, topics: [], extractions: [] });
      expect(detail.extractionRecord).toBeNull();
      expect(detail.evidenceMessage).toContain("未绑定可确认");
      expect(detail.interactionTotal).toBe(10);
    },
  );

  it("后续超过五次采集及当前笔记变化不影响旧绑定", () => {
    const { result } = fixture();
    const before = withAuditExtractionSnapshot(result);
    for (let i = 0; i < 8; i += 1) {
      Object.assign(result.note, { body: `new-body-${i}`, pageStatus: "NORMAL", topics: [] });
      expect(withAuditExtractionSnapshot(result)).toEqual(before);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveXhsNoteIdCreationTime,
  PUBLISHED_TIME_CONFLICT,
  resolveXhsOriginalPublishedAt,
  STRUCTURED_PUBLISHED_TIME,
  withXhsOriginalPublishedAt,
  XHS_NOTE_ID_DERIVED_CREATION_TIME,
} from "@/lib/xhs-original-published-at";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const REAL_EVIDENCE_ID = "6a69c3130123456789abcdef";

describe("小红书 Note ID 原始发布时间", () => {
  it("使用真实 LEVEL_A 验证样本的同算法 fixture", () => {
    expect(deriveXhsNoteIdCreationTime(REAL_EVIDENCE_ID, NOW)?.toISOString()).toBe(
      "2026-07-29T09:08:35.000Z",
    );
  });

  it("推导合法 24 位 hex Note ID", () => {
    expect(deriveXhsNoteIdCreationTime(REAL_EVIDENCE_ID, NOW)).toBeInstanceOf(Date);
  });

  it("接受 uppercase hex", () => {
    expect(
      deriveXhsNoteIdCreationTime(REAL_EVIDENCE_ID.toUpperCase(), NOW)?.toISOString(),
    ).toBe("2026-07-29T09:08:35.000Z");
  });

  it("拒绝非 24 位 ID", () => {
    expect(deriveXhsNoteIdCreationTime(REAL_EVIDENCE_ID.slice(0, 23), NOW)).toBeNull();
  });

  it("拒绝非 hex ID", () => {
    expect(deriveXhsNoteIdCreationTime("zz69c3130123456789abcdef", NOW)).toBeNull();
  });

  it("拒绝早于 2013-01-01 的时间", () => {
    expect(deriveXhsNoteIdCreationTime("000000010123456789abcdef", NOW)).toBeNull();
  });

  it("拒绝晚于当前执行时间 24 小时的异常未来时间", () => {
    const futurePrefix = Math.floor(
      (NOW.getTime() + 25 * 60 * 60 * 1_000) / 1_000,
    ).toString(16);
    expect(
      deriveXhsNoteIdCreationTime(`${futurePrefix}0123456789abcdef`, NOW),
    ).toBeNull();
  });

  it("结构化当前作品发布时间优先于 Note ID", () => {
    const result = resolveXhsOriginalPublishedAt({
      platformNoteId: REAL_EVIDENCE_ID,
      publishedAt: "2026-07-29T09:09:00.000Z",
      publishedAtSource: "NETWORK_JSON:create_time",
      now: NOW,
    });
    expect(result.originalPublishedAtSource).toBe(STRUCTURED_PUBLISHED_TIME);
    expect(result.originalPublishedAt).toBe("2026-07-29T09:09:00.000Z");
  });

  it("结构化时间与 Note ID 一致时保留 supporting evidence", () => {
    const result = resolveXhsOriginalPublishedAt({
      platformNoteId: REAL_EVIDENCE_ID,
      publishedAt: "2026-07-29T09:08:35.000Z",
      publishedAtSource: "PAGE_JSON:publish_time|DOM_MAIN_NOTE:time",
      now: NOW,
    });
    expect(result.originalPublishedAtSource).toBe(STRUCTURED_PUBLISHED_TIME);
    expect(result.originalPublishedAtEvidence).toEqual({
      structuredPublishedAt: "2026-07-29T09:08:35.000Z",
      noteIdDerivedCreationTime: "2026-07-29T09:08:35.000Z",
      differenceSeconds: 0,
    });
  });

  it("结构化时间与 Note ID 明显冲突时不静默选值", () => {
    const result = resolveXhsOriginalPublishedAt({
      platformNoteId: REAL_EVIDENCE_ID,
      publishedAt: "2026-08-01T09:08:35.000Z",
      publishedAtSource: "NETWORK_JSON:publish_time",
      now: NOW,
    });
    expect(result).toMatchObject({
      originalPublishedAt: null,
      originalPublishedAtStatus: "CONFLICT",
      originalPublishedAtCode: PUBLISHED_TIME_CONFLICT,
    });
    expect(result.originalPublishedAtEvidence.structuredPublishedAt).not.toBeNull();
    expect(result.originalPublishedAtEvidence.noteIdDerivedCreationTime).not.toBeNull();
  });

  it("编辑于 4小时前只保留为平台显示时间，原始时间来自 Note ID", () => {
    const row = withXhsOriginalPublishedAt({
      note: {
        contentChannel: "XIAOHONGSHU",
        platformNoteId: REAL_EVIDENCE_ID,
        publishedAt: null,
        publishedAtRaw: "编辑于 4小时前",
        publishedAtSource: "DOM_MAIN_NOTE:time",
      },
      task: { channel: "XIAOHONGSHU" },
    }, NOW);
    expect(row.note.publishedAtRaw).toBe("编辑于 4小时前");
    expect(row.note.originalPublishedAtSource).toBe(
      XHS_NOTE_ID_DERIVED_CREATION_TIME,
    );
  });

  it("07-29 只保留为平台显示时间，原始时间来自 Note ID", () => {
    const row = withXhsOriginalPublishedAt({
      note: {
        contentChannel: "XIAOHONGSHU",
        platformNoteId: REAL_EVIDENCE_ID,
        publishedAt: null,
        publishedAtRaw: "07-29",
        publishedAtSource: "DOM_MAIN_NOTE:time",
      },
    }, NOW);
    expect(row.note.publishedAtRaw).toBe("07-29");
    expect(row.note.originalPublishedAt).toBe("2026-07-29T09:08:35.000Z");
  });

  it("无 Note ID 且无结构化时间时不猜测", () => {
    expect(resolveXhsOriginalPublishedAt({ now: NOW })).toMatchObject({
      originalPublishedAt: null,
      originalPublishedAtStatus: "UNCONFIRMED",
    });
  });

  it("历史 Result 可在只读展示层派生且不修改输入", () => {
    const historical = {
      id: "historical-result",
      note: {
        contentChannel: "XIAOHONGSHU",
        platformNoteId: REAL_EVIDENCE_ID,
        publishedAt: null,
        publishedAtSource: null,
      },
      task: { channel: "XIAOHONGSHU" },
    };
    const before = structuredClone(historical);
    const presented = withXhsOriginalPublishedAt(historical, NOW);
    expect(presented.note.originalPublishedAt).toBe("2026-07-29T09:08:35.000Z");
    expect(historical).toEqual(before);
  });

  it("auditedAt 不得成为发布时间 fallback", () => {
    const presented = withXhsOriginalPublishedAt({
      auditedAt: "2026-08-22T10:00:00.000Z",
      note: {
        contentChannel: "XIAOHONGSHU",
        platformNoteId: null,
        publishedAt: null,
        publishedAtSource: null,
      },
    }, NOW);
    expect(presented.note.originalPublishedAt).toBeNull();
  });
});

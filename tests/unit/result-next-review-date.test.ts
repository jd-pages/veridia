import { afterEach, describe, expect, it, vi } from "vitest";
import { resultBoundNextReviewDate, resultBoundManualReviewDate } from "@/lib/result-next-review-date";
import fs from "node:fs";

afterEach(() => vi.useRealTimers());

const evidence = { evidenceStatus: "RESULT_BOUND" as const, publishedAtSource: "NETWORK_JSON:note.publish_time" };
describe("Result-bound next review business date", () => {
  it("Protected KABRITA_NEXT_REVIEW_DATE：Asia/Shanghai发帖日期加30自然日，与审核时间无关", () => {
    vi.useFakeTimers();
    for (const now of ["2026-10-16T02:00:00Z", "2027-01-01T00:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      for (const [publishedAt, expected] of [
        ["2026-10-01T02:00:00Z", "2026-10-31"],
        ["2026-10-01T15:30:00Z", "2026-10-31"],
        ["2026-09-30T16:30:00Z", "2026-10-31"],
        ["2026-10-15T23:30:00+08:00", "2026-11-14"],
        ["2026-12-15T23:30:00+08:00", "2027-01-14"],
      ]) {
        expect(resultBoundNextReviewDate({ ...evidence, publishedAt })?.toISOString()).toBe(`${expected}T00:00:00.000Z`);
      }
    }
  });

  it("可靠Date对象与绝对日期可用，缺证据和相对日期不猜年份", () => {
    expect(resultBoundNextReviewDate({ ...evidence, publishedAt: new Date("2026-10-01T15:30:00Z") }))
      .toEqual(new Date("2026-10-31T00:00:00Z"));
    expect(resultBoundNextReviewDate({ ...evidence, publishedAt: "2026-10-01" }))
      .toEqual(new Date("2026-10-31T00:00:00Z"));
    for (const publishedAt of [null, undefined, "昨天", "10-01", "2026-10-01 23:30:00", "2026-02-30", "2026-02-30T10:00:00+08:00", "invalid", new Date("invalid")]) {
      expect(resultBoundNextReviewDate({ ...evidence, publishedAt })).toBeNull();
    }
    expect(resultBoundNextReviewDate({ ...evidence, publishedAt: "2026-10-01", evidenceStatus: "LEGACY_UNAVAILABLE" })).toBeNull();
    expect(resultBoundNextReviewDate({ ...evidence, publishedAt: "2026-10-01", evidenceStatus: undefined })).toBeNull();
  });

  it("note-id推导或编辑时间不可冒充可靠发帖时间", () => {
    for (const publishedAtSource of [null, "", "NOTE_ID", "NOTE_ID_DERIVED", "DOM_MAIN_NOTE:NOTE_ID", "CURRENT_NOTE", "UNKNOWN"]) {
      expect(resultBoundNextReviewDate({ ...evidence, publishedAt: "2026-10-01", publishedAtSource })).toBeNull();
    }
    expect(resultBoundNextReviewDate({ ...evidence, publishedAt: "2026-10-01", publishedAtSource: "DOM_MAIN_NOTE:span.date", publishedAtRaw: "编辑于 2026-10-01" })).toBeNull();
    expect(resultBoundNextReviewDate({ ...evidence, publishedAt: "2026-10-01", publishedAtSource: "DOM_MAIN_NOTE:span.date", publishedAtRaw: "2026-10-01 上海" }))
      .toEqual(new Date("2026-10-31T00:00:00Z"));
    for (const publishedAtRaw of ["10-01", "昨天", "2小时前", "10月1日"]) {
      expect(resultBoundNextReviewDate({ ...evidence, publishedAt: new Date("2026-10-01T00:00:00Z"),
        publishedAtSource: "DOM_MAIN_NOTE:span.date", publishedAtRaw })).toBeNull();
    }
  });
});

describe("Estimated manual XHS review dates never become publication evidence", () => {
  const id = `${Math.floor(Date.parse("2026-10-01T15:30:00Z") / 1000).toString(16)}0000000000000001`;
  const base = { evidenceStatus: "RESULT_BOUND" as const, contentChannel: "XIAOHONGSHU",
    publishedAt: null, platformNoteId: id, noteUrl: `https://www.xiaohongshu.com/explore/${id}`,
    capturedAt: "2026-10-24T00:00:00Z" };
  const now = new Date("2026-10-24T02:00:00Z");
  it("uses the existing ID decoder, preserving real dates and original input", () => {
    const original = JSON.stringify(base);
    expect(resultBoundManualReviewDate(base, now)).toMatchObject({
      date: new Date("2026-10-31T00:00:00Z"), estimated: true, noteId: id,
      reason: expect.stringContaining("仅供人工安排复查"),
    });
    expect(JSON.stringify(base)).toBe(original);
    expect(resultBoundNextReviewDate(base)).toBeNull();
    expect(resultBoundManualReviewDate({ ...base, ...evidence, publishedAt: "2026-10-05T02:00:00Z" }, now))
      .toMatchObject({ date: new Date("2026-11-04T00:00:00Z"), estimated: false });
  });
  it("accepts only exact trusted XHS paths when the bound ID is absent", () => {
    expect(resultBoundManualReviewDate({ ...base, platformNoteId: null,
      noteUrl: `https://www.xiaohongshu.com/discovery/item/${id}?source=share` }, now).estimated).toBe(true);
    for (const noteUrl of [`https://www.xiaohongshu.com.evil.test/explore/${id}`,
      `https://evil.test/?url=https://www.xiaohongshu.com/explore/${id}`, `https://www.xiaohongshu.com/search_result?keyword=${id}`]) {
      expect(resultBoundManualReviewDate({ ...base, platformNoteId: null, noteUrl }, now).date).toBeNull();
    }
  });
  it("rejects mismatches, malformed IDs, impossible times and unbound/cross-channel data", () => {
    for (const patch of [
      { originalUrl: "https://www.xiaohongshu.com/explore/6a0000000000000000000000" },
      { platformNoteId: "bad" }, { platformNoteId: "ffffffffffffffffffffffff", noteUrl: null },
      { platformNoteId: "000000000000000000000000", noteUrl: null },
      { contentChannel: "DOUYIN" }, { evidenceStatus: "LEGACY_UNAVAILABLE" as const },
      { capturedAt: "invalid" }, { capturedAt: "2026-09-01T00:00:00Z" },
    ]) expect(resultBoundManualReviewDate({ ...base, ...patch }, now).date).toBeNull();
    const service = fs.readFileSync("lib/automation/result-follow-up.ts", "utf8");
    expect(service).toContain("resultBoundNextReviewDate");
    expect(service).not.toContain("resultBoundManualReviewDate");
    expect(service).not.toContain("nextReviewEstimated");
  });
});

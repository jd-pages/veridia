import { afterEach, describe, expect, it, vi } from "vitest";
import { resultBoundNextReviewDate } from "@/lib/result-next-review-date";

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

import { describe, expect, it } from "vitest";
import { auditResultToWyethNestleExportRecord, buildConfiguredWorkbook, buildConfiguredCsv, type CompactAuditResultExportSourceRow } from "@/lib/import-export-templates/export";
import ExcelJS from "exceljs";
import { BUILTIN_IMPORT_EXPORT_TEMPLATES } from "@/lib/import-export-templates/config";
import { buildAuditResultPresentation } from "@/lib/audit-result-presentation";
import { resultBoundManualReviewDate } from "@/lib/result-next-review-date";

function source(brand = "惠氏", total = 10): CompactAuditResultExportSourceRow {
  const ruleSnapshot = JSON.stringify({ brandName: brand, productId: "product", campaignId: "campaign", contentChannel: "XIAOHONGSHU",
    rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: false, baseRewardAmount: 40,
    interactionRewardTiers: [{ threshold: 10, amount: 10 }], minImageCount: 0, rules: [] });
  const presentation = buildAuditResultPresentation({ autoStatus: "PASSED", pageStatus: "NORMAL", bodyStatus: "PRESENT", bodyCompliant: true,
    imageStatus: "NOT_REQUIRED", imageCompliant: true, imageCount: 0, noteType: "VIDEO", imageExtractionStatus: "VIDEO_NOTE",
    topicsCompliant: true, clickableCompliant: true, publicStatus: "PUBLIC", retentionStatus: "UNKNOWN", failureReasons: "[]",
    missingTopics: "[]", forbiddenTopics: "[]", ruleSnapshot, evidenceStatus: "RESULT_BOUND", ruleResults: [], manualReviews: [],
    task: { product: { brandName: brand }, pageType: "VIDEO_DETAIL" }, note: { noteType: "VIDEO", pageType: "VIDEO_DETAIL", topics: [] } });
  return { autoStatus: "PASSED", pageStatus: "NORMAL", bodyStatus: "PRESENT", topicsCompliant: true, failureReasons: "[]",
    imageExtractionStatus: "VIDEO_NOTE", imageStatus: "NOT_REQUIRED", likeCount: total, commentCount: 0, favoriteCount: 0,
    interactionTotal: total, ruleSnapshot, presentation, evidenceStatus: "RESULT_BOUND", manualReviews: [],
    task: { url: "https://www.xiaohongshu.com/explore/invalid", notes: null, failureCode: null, failureMessage: null,
      pageTitle: null, pageType: "VIDEO_DETAIL", productStage: null, platform: "XIAOHONGSHU", channel: "XIAOHONGSHU",
      product: { id: "product", name: "产品", brandName: brand }, campaign: { id: "campaign", name: "活动" } },
    note: { url: "https://www.xiaohongshu.com/explore/invalid", finalUrl: null, title: "正文", body: "正文",
      publishedAt: new Date("2026-10-24T16:30:00Z"), publishedAtSource: "NETWORK_JSON:note.publish_time" } };
}

describe("Wyeth/Nestle frozen 40+10 contract business export", () => {
  it("standalone XLSX/CSV stay exactly 19 columns even with saved reward details", async () => {
    const record = { ...auditResultToWyethNestleExportRecord(source()), interactionRewardStatus: "QUALIFIED" };
    const options = { templates: BUILTIN_IMPORT_EXPORT_TEMPLATES, kind: "auditResults" as const, templateType: "WYETH" as const, records: [record] };
    const wb = new ExcelJS.Workbook();await wb.xlsx.load(await buildConfiguredWorkbook(options) as ExcelJS.Buffer);
    expect(wb.worksheets[0].columnCount).toBe(19);expect(wb.worksheets[0].getCell("S2").value).toBe(50);
    expect(buildConfiguredCsv(options)).not.toContain("互动奖励结果");expect(buildConfiguredCsv(options)).not.toContain("点赞数");
  });
  it.each(["惠氏", "雀巢"])("%s counts 0/9/10/11/20 use inclusive ten, keeping review date at 15 days", brand => {
    for (const total of [0, 9, 10, 11, 20]) expect(auditResultToWyethNestleExportRecord(source(brand, total))).toMatchObject({
      selfReview: "Y", interactionTotal: total, interactionAtLeastTen: total >= 10 ? "Y" : "N", payoutAmount: total >= 10 ? 50 : 40,
      nextReviewAt: new Date("2026-11-09T00:00:00Z"), nextReviewEstimated: false,
      remark: "", brandInitialReview: "", brandFinalReview: "", rewardPaymentStatus: "",
    });
  });
  it("never invents missing counters, unconfirmed/mismatched contracts or failed-content payouts", () => {
    const row = source();
    for (const patch of [
      { likeCount: null }, { interactionTotal: null }, { interactionTotal: 11 },
      { likeCount: undefined, commentCount: undefined, favoriteCount: undefined },
    ]) expect(auditResultToWyethNestleExportRecord({ ...row, ...patch })).toMatchObject({ interactionTotal: null, interactionAtLeastTen: "", payoutAmount: null });
    for (const config of [{}, { rewardMode: "LEGACY" }, ...[
      { brandName: "雀巢" }, { productId: "other" }, { campaignId: "other" }, { contentChannel: "DOUYIN" },
      { baseRewardAmount: 50 }, { interactionRewardTiers: [{ threshold: 11, amount: 10 }] },
    ].map(p => ({ ...JSON.parse(row.ruleSnapshot!), ...p }))]) {
      expect(auditResultToWyethNestleExportRecord({ ...row, ruleSnapshot: JSON.stringify(config) }).payoutAmount).toBeNull();
    }
    expect(auditResultToWyethNestleExportRecord({ ...row, manualReviews: [{ result: "FAILED", comment: "不合规" }] }).payoutAmount).toBeNull();
    expect(auditResultToWyethNestleExportRecord({ ...row, pageStatus: "NOTE_NOT_FOUND" })).toMatchObject({ interactionTotal: null, payoutAmount: null, nextReviewAt: "不适用" });
  });
  it("15-day manual estimates preserve the default 30-day contract and all identity guards", () => {
    const id = Math.floor(Date.parse("2026-12-25T16:10:00Z") / 1000).toString(16) + "0000000000000001";
    const input = { evidenceStatus: "RESULT_BOUND" as const, publishedAt: null, platformNoteId: id,
      contentChannel: "XIAOHONGSHU", noteUrl: `https://www.xiaohongshu.com/explore/${id}`, capturedAt: "2027-01-01T00:00:00Z" };
    const now = new Date("2027-01-01T00:00:00Z");
    expect(resultBoundManualReviewDate(input, now, 15)).toMatchObject({ date: new Date("2027-01-10T00:00:00Z"), estimated: true, reason: expect.stringContaining("加15个北京时间自然日") });
    expect(resultBoundManualReviewDate(input, now).date).toEqual(new Date("2027-01-25T00:00:00Z"));
    expect(resultBoundManualReviewDate({ ...input, finalUrl: "https://www.xiaohongshu.com/explore/123456780000000000000000" }, now, 15).date).toBeNull();
    expect(resultBoundManualReviewDate({ ...input, publishedAt: "2026-12-28T00:00:00Z", publishedAtSource: "NETWORK_JSON:note.publish_time" }, now, 15))
      .toMatchObject({ date: new Date("2027-01-12T00:00:00Z"), estimated: false });
  });
});

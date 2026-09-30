import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { assertAuditEvaluationConsistency } from "@/lib/audit-evaluation-consistency";
import { buildAuditResultPresentation } from "@/lib/audit-result-presentation";
import { createMockNote } from "@/lib/mock-data";
import { rewardFromResultSnapshot } from "@/lib/interaction-reward";
import {
  auditResultToKabritaExportRecord,
  auditTaskToUnreviewedKabritaExportRecord,
  buildConfiguredCsv,
  buildConfiguredWorkbook,
  buildUnifiedAuditResultsWorkbook,
  type CompactAuditResultExportSourceRow,
} from "@/lib/import-export-templates/export";
import { BUILTIN_IMPORT_EXPORT_TEMPLATES } from "@/lib/import-export-templates/config";
import { buildImportedTaskNotes, importedTemplateMetadataFromNotes } from "@/lib/import-task-metadata";
import type { AuditContext } from "@/lib/types";

const tiers = [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }];
const context: AuditContext = {
  productId: "october-product", campaignId: "october-campaign", campaignName: "可配置阶梯活动",
  contentChannel: "XIAOHONGSHU", ruleVersion: 4, minImageCount: 2, minBodyLength: 21,
  bodyRequired: true, publicRequired: true, retentionDays: 30, clickableTopicRequired: true,
  rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: true,
  baseRewardAmount: 50, interactionRewardTiers: tiers, rules: [],
};
const snapshot = JSON.stringify(context);
const headers = [
  "登记时间", "渠道", "店铺名称", "客户备注", "买家购买ID", "购买订单号", "购买时间",
  "购买罐数", "参与次数", "发布小红书账号", "小红书发布链接", "购买产品线", "是否符合",
  "客服备注", "互动量", "额外奖励金额", "下次审核时间",
];

function reward(total: number, finalContentStatus = "PASSED") {
  return rewardFromResultSnapshot({ ruleSnapshot: snapshot, finalContentStatus, autoStatus: finalContentStatus,
    pageStatus: "NORMAL", likeCount: total, commentCount: 0, favoriteCount: 0 });
}

function row(overrides: Partial<CompactAuditResultExportSourceRow> = {}): CompactAuditResultExportSourceRow {
  const url = "https://www.xiaohongshu.com/explore/immutable-october";
  return {
    autoStatus: "PASSED", pageStatus: "NORMAL", bodyStatus: "PRESENT", topicsCompliant: true,
    failureReasons: "[]", ruleSnapshot: snapshot, evidenceStatus: "RESULT_BOUND",
    imageExtractionStatus: "SUCCESS", imageStatus: "COMPLIANT", likeCount: 10, commentCount: 3,
    favoriteCount: 2, interactionTotal: 15,
    task: { url, failureCode: null, failureMessage: null, pageTitle: "历史作品", pageType: "NOTE_DETAIL",
      productStage: null, campaign: { name: "活动", month: "2026-10" },
      product: { name: "佳贝艾特测试产品", brandName: "佳贝艾特" },
      notes: buildImportedTaskNotes({ templateMetadata: { templateType: "KABRITA", templateBrand: "佳贝艾特",
        rawValues: { registrationTime: "2026-10-16 09:00", channel: "京东", shopName: "原店名",
          customerRemark: "客户原备注", customerServiceComment: "客服原备注 =SUM(1,2)", buyerPurchaseId: "000001",
          purchaseOrderNumber: "000002", purchaseTime: "2026-09-28", purchaseCanCount: "02",
          participationCount: "01", xiaohongshuAccount: "原账号", xiaohongshuPublishLink: `原分享文案 ${url}`,
          purchaseProductLine: "原产品线", activityMonth: "10月", complianceResult: "旧源N" } } }),
    },
    note: { url, finalUrl: url, title: "历史作品", body: "历史正文", publishedAt: new Date("2026-10-01T15:30:00Z"),
      publishedAtRaw: "2026-10-01 23:30", publishedAtSource: "NETWORK_JSON:note.publish_time" },
    manualReviews: [], ...overrides,
  };
}

describe("Kabrita October reward contract", () => {
  it("Protected KABRITA_OCTOBER_REWARD_DECOUPLING：0/9/10/11/39/40/41/100只取最高档且内容失败为零", () => {
    for (const [total, amount] of [[0, 0], [9, 0], [10, 20], [11, 20], [39, 20], [40, 50], [41, 50], [100, 50]]) {
      expect(reward(total)).toMatchObject({ total, baseRewardAmount: 50, extraRewardAmount: amount });
      expect(reward(total, "FAILED")).toMatchObject({ total, baseRewardAmount: 0, extraRewardAmount: 0 });
    }
    expect(reward(40)).toMatchObject({ qualifiedTier: tiers[1], nextTier: null, maxTierReached: true });
    expect(reward(9)).toMatchObject({ qualifiedTier: null, nextTier: tiers[0], maxTierReached: false });
    expect(reward(10)).toMatchObject({ qualifiedTier: tiers[0], nextTier: tiers[1] });
  });

  it("阶梯模式互动0或缺失不改变内容审核，legacy基础门槛仍保留", () => {
    const note = { ...createMockNote("passed"), isPublic: true, likeCount: 0, commentCount: 0,
      favoriteCount: 0, interactionExtractionStatus: "SUCCESS" as const };
    for (const counts of [note, { ...note, likeCount: null, commentCount: 3, favoriteCount: null }]) {
      const result = evaluateAudit(counts, context);
      expect(result).toMatchObject({ autoStatus: "PASSED", failureReasons: [] });
      expect(result.ruleResults.some((rule) => rule.ruleKey === "KABRITA_BASIC_REWARD")).toBe(false);
      expect(() => assertAuditEvaluationConsistency(result)).not.toThrow();
    }
    const legacy = { ...context, rewardMode: "LEGACY" as const, interactionRewardTiers: [] };
    expect(evaluateAudit(note, legacy)).toMatchObject({ autoStatus: "FAILED",
      failureReasons: ["基础奖励未达成：互动合计 0"] });
    expect(evaluateAudit({ ...note, likeCount: null }, legacy).autoStatus).toBe("NEEDS_REVIEW");
    expect(evaluateAudit({ ...note, likeCount: 10 }, legacy).autoStatus).toBe("PASSED");
  });

  it("retentionDays和发帖节点不改变阶梯内容结论", () => {
    for (const publishedAt of [null, "2026-10-01T02:00:00Z", "2020-01-01T00:00:00Z"]) {
      const result = evaluateAudit({ ...createMockNote("passed"), publishedAt, isPublic: true,
        likeCount: 0, commentCount: 0, favoriteCount: 0, interactionExtractionStatus: "SUCCESS" }, context);
      expect(result).toMatchObject({ autoStatus: "PASSED", failureReasons: [] });
      expect(result.autoStatus).not.toBe("PENDING_RETENTION");
      expect(result.ruleResults.find((rule) => rule.ruleKey === "GLOBAL_RETENTION")?.passed).toBe(true);
    }
  });

  it("技术失败与未审核奖励留空，可读null/3/null只在投影层按3计算", () => {
    const raw = { likeCount: null, commentCount: 3, favoriteCount: null, interactionTotal: null };
    const input = { ruleSnapshot: snapshot, finalContentStatus: "PASSED", autoStatus: "PASSED", pageStatus: "NORMAL", ...raw };
    expect(rewardFromResultSnapshot(input)).toMatchObject({ total: 3, baseRewardAmount: 50, extraRewardAmount: 0 });
    for (const status of ["READ_FAILED", "LOGIN_EXPIRED", "SECURITY_VERIFICATION", "PAGE_READ_FAILED", "NETWORK_ERROR", "STRUCTURE_MISMATCH", "NOTE_NOT_FOUND"]) {
      expect(rewardFromResultSnapshot({ ...input, pageStatus: status })).toMatchObject({ total: null, extraRewardAmount: null });
      expect(rewardFromResultSnapshot({ ...input, failureCode: status })).toMatchObject({ total: null, extraRewardAmount: null });
    }
    expect(rewardFromResultSnapshot({ ...input, autoStatus: "PENDING" })).toMatchObject({ total: null, extraRewardAmount: null });
    expect(raw).toEqual({ likeCount: null, commentCount: 3, favoriteCount: null, interactionTotal: null });
  });

  it("历史reward snapshot不可变，人工结论单独决定奖励资格", () => {
    const saved = row();
    const currentCampaign = { ...saved.task.campaign!, baseRewardAmount: 50, interactionRewardTiers: tiers };
    const withCurrentCampaign = { ...saved, task: { ...saved.task, campaign: currentCampaign } };
    const historicalReward = auditResultToKabritaExportRecord(withCurrentCampaign);
    Object.assign(currentCampaign, { baseRewardAmount: 999, interactionRewardTiers: [{ threshold: 20, amount: 30 }] });
    expect(auditResultToKabritaExportRecord(withCurrentCampaign)).toEqual(historicalReward);
    expect(auditResultToKabritaExportRecord(saved)).toMatchObject({ complianceResult: "Y", interactionTotal: 15, extraRewardAmount: 20 });
    expect(auditResultToKabritaExportRecord({ ...saved, manualReviews: [{ result: "FAILED", comment: "人工不通过" }] }))
      .toMatchObject({ complianceResult: "N", interactionTotal: 15, extraRewardAmount: 0 });
    expect(auditResultToKabritaExportRecord({ ...saved, autoStatus: "FAILED", manualReviews: [{ result: "PASSED", comment: "人工通过" }] }))
      .toMatchObject({ complianceResult: "Y", interactionTotal: 15, extraRewardAmount: 20 });
    const presentation = buildAuditResultPresentation({ ...saved, ruleSnapshot: snapshot, bodyCompliant: true, imageCompliant: true,
      clickableCompliant: true, publicStatus: "PUBLIC", retentionStatus: "PENDING", missingTopics: "[]", forbiddenTopics: "[]",
      interactionRewardStatus: "PENDING", ruleResults: [], evidenceStatus: "RESULT_BOUND" });
    expect(presentation).toMatchObject({ conclusion: { status: "PASSED" }, reward: { baseRewardAmount: 50, extraRewardAmount: 20 } });
    expect(saved.ruleSnapshot).toBe(snapshot);
  });

  it("Protected KABRITA_17_COLUMN_AUDIT_EXPORT：实际XLSX严格17列、数值和日期类型、原字段分离保存", async () => {
    const input = row();
    const before = structuredClone(input);
    const record = auditResultToKabritaExportRecord(input);
    expect(record).toMatchObject({ customerRemark: "客户原备注", customerServiceComment: "客服原备注 =SUM(1,2)",
      buyerPurchaseId: "000001", purchaseOrderNumber: "000002", purchaseCanCount: "02", activityMonth: "10月",
      interactionTotal: 15, extraRewardAmount: 20, nextReviewAt: new Date("2026-10-31T00:00:00Z") });
    const bytes = await buildConfiguredWorkbook({ templates: BUILTIN_IMPORT_EXPORT_TEMPLATES, kind: "auditResults",
      records: [record], sections: [{ sheetName: "佳贝艾特审核结果", templateBrand: "佳贝艾特", records: [record], fields: ["failedReasons", "activityMonth"] }] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(headers);
    expect(sheet.columnCount).toBe(17);
    expect(sheet.getCell("O2")).toMatchObject({ type: ExcelJS.ValueType.Number, value: 15 });
    expect(sheet.getCell("P2")).toMatchObject({ type: ExcelJS.ValueType.Number, value: 20 });
    expect(sheet.getCell("Q2")).toMatchObject({ type: ExcelJS.ValueType.Date, value: new Date("2026-10-31T00:00:00Z"), numFmt: "yyyy-mm-dd" });
    expect(sheet.getCell("D2").text).toBe("客户原备注");
    expect(sheet.getCell("N2").text).toBe("客服原备注 =SUM(1,2)");
    const raw = importedTemplateMetadataFromNotes(input.task.notes)!.rawValues;
    for (const [field, value] of Object.entries(raw).filter(([field]) => !["activityMonth", "complianceResult"].includes(field))) {
      expect(record[field as keyof typeof record], field).toBe(value);
    }
    expect(input).toEqual(before);
    const csv = buildConfiguredCsv({ templates: BUILTIN_IMPORT_EXPORT_TEMPLATES, kind: "auditResults", templateType: "KABRITA", records: [record] });
    expect(csv.split("\r\n")[0].replace(/^\uFEFF/u, "").split(",")).toEqual(headers);
    expect(csv).toContain("2026-10-31");
    const unified = new ExcelJS.Workbook();
    await unified.xlsx.load(await buildUnifiedAuditResultsWorkbook({ templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      danoneRecords: [], kabritaRecords: [record], wyethRecords: [], nestleRecords: [] }) as ExcelJS.Buffer);
    expect((unified.getWorksheet("佳贝艾特审核结果")!.getRow(1).values as unknown[]).slice(1)).toEqual(headers);
  });

  it("未审核与技术失败17列保持空白，客服备注不填入失败或人工原因", async () => {
    const source = row();
    const unreviewed = auditTaskToUnreviewedKabritaExportRecord({ ...source.task, originalInput: source.task.url });
    const failed = auditResultToKabritaExportRecord({ ...source, pageStatus: "READ_FAILED", autoStatus: "READ_FAILED" });
    for (const record of [unreviewed, failed]) {
      expect(record).toMatchObject({ complianceResult: "", interactionTotal: null, extraRewardAmount: null, nextReviewAt: null });
    }
    expect(auditResultToKabritaExportRecord({ ...source, task: { ...source.task, notes: null },
      manualReviews: [{ result: "FAILED", comment: "人工原因" }] }).customerServiceComment).toBe("");
  });
});

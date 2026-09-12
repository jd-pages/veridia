import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  calculateInteractionTotal,
  evaluateInteractionReward,
  interactionAtLeastTenExportValue,
  interactionRewardPresentation,
} from "@/lib/interaction-reward";
import { extractDouyinInteraction, extractDouyinPublicStatus } from "@/lib/automation/douyin-interaction";
import { evaluateAudit } from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import type { AuditContext } from "@/lib/types";
import InteractionReward from "@/components/results/InteractionReward";
import update from "@/rules/updates/2026-09-interaction-reward.json";
import { validateRulePayload } from "@/lib/rules/package";
import builtin from "@/rules/default-rules.json";
import { buildConfiguredCsv, buildConfiguredWorkbook } from "@/lib/import-export-templates/export";
import { BUILTIN_IMPORT_EXPORT_TEMPLATES } from "@/lib/import-export-templates/config";
import ExcelJS from "exceljs";

const config = { interactionRewardEnabled: true, interactionRewardThreshold: 10 };
describe("互动额外奖励", () => {
  it("所有品牌复用点赞+评论+收藏口径，10/9/未知分别输出 Y/N/空", () => {
    expect(calculateInteractionTotal({
      likeCount: 5,
      commentCount: 3,
      favoriteCount: 2,
      interactionExtractionStatus: "SUCCESS",
    }).interactionTotal).toBe(10);
    expect(interactionAtLeastTenExportValue({ interactionTotal: 10 })).toBe("Y");
    expect(interactionAtLeastTenExportValue({ interactionTotal: 9 })).toBe("N");
    expect(interactionAtLeastTenExportValue({ interactionTotal: null })).toBe("");
  });
  it.each([[3, 2, 5, "QUALIFIED"], [3, 2, 4, "NOT_QUALIFIED"], [0, 0, 0, "NOT_QUALIFIED"], [null, 3, 2, "PENDING"]] as const)(
    "%s/%s/%s => %s", (likeCount, commentCount, favoriteCount, status) => {
      const result = evaluateInteractionReward({ likeCount, commentCount, favoriteCount, interactionExtractionStatus: "SUCCESS" }, config);
      expect(result.interactionRewardStatus).toBe(status);
      expect(result.interactionTotal).toBe(likeCount === null ? null : likeCount + commentCount + favoriteCount);
    });
  it("旧活动默认不开启、冲突不算总数、阈值可改且旧快照不漂移", () => {
    const note = { likeCount: 3, commentCount: 2, favoriteCount: 5, interactionExtractionStatus: "SUCCESS" };
    expect(evaluateInteractionReward(note, {}).interactionRewardStatus).toBe("NOT_ENABLED");
    expect(evaluateInteractionReward({ ...note, interactionExtractionStatus: "UNAVAILABLE" }, config).interactionTotal).toBeNull();
    const saved = JSON.parse(JSON.stringify(evaluateInteractionReward(note, config)));
    expect(evaluateInteractionReward(note, { ...config, interactionRewardThreshold: 20 }).interactionRewardStatus).toBe("NOT_QUALIFIED");
    expect(saved).toMatchObject({ interactionRewardThreshold: 10, interactionRewardStatus: "QUALIFIED" });
  });
  for (const channel of ["XIAOHONGSHU", "DOUYIN"] as const) {
    for (const product of update.products) {
      it(`${channel}/${product.name} 四话题必需、正文21字通过、20字失败、非公开失败、奖励独立`, () => {
        const context: AuditContext = { productId: product.key, campaignId: channel, campaignName: product.name,
          contentChannel: channel, ruleVersion: 1, ...update.campaign,
          rules: product.topics.map((topic, index) => ({ id: String(index), scope: "CAMPAIGN", topic,
            ruleType: "MUST_ALL", exactMatch: true, clickableRequired: true, caseSensitive: true, minCount: 1, sortOrder: index, version: 1 })) };
        const note = createMockNote("passed");
        note.body = "真".repeat(21);
        note.imageCount = 2;
        note.isPublic = true;
        note.publishedAt = "2026-01-01T00:00:00Z";
        note.topics = product.topics.map((displayText) => ({ ...note.topics[0], displayText, source: "STRUCTURED_RESPONSE", isClickable: true }));
        note.verifiedPlatformTopics = note.topics;
        note.verifiedDouyinTopics = note.topics;
        const passed = evaluateAudit(note, context);
        expect(passed.autoStatus).toBe("PASSED");
        expect(passed.interactionReward?.interactionRewardStatus).toBe("PENDING");
        expect(evaluateAudit({ ...note, body: "真".repeat(20) }, context).bodyCompliant).toBe(false);
        expect(evaluateAudit({ ...note, isPublic: false }, context).autoStatus).toBe("FAILED");
        expect(evaluateAudit({ ...note, imageCount: 1 }, context).imageCompliant).toBe(false);
        expect(evaluateAudit({ ...note, publishedAt: new Date().toISOString() }, context).autoStatus).toBe("NEEDS_REVIEW");
        const low = evaluateAudit({ ...note, likeCount: 3, commentCount: 2, favoriteCount: 4, interactionExtractionStatus: "SUCCESS" }, context);
        expect(low.autoStatus).toBe("PASSED");
        expect(low.interactionReward?.interactionRewardStatus).toBe("NOT_QUALIFIED");
        const missing = { ...note, topics: note.topics.slice(1), verifiedPlatformTopics: note.topics.slice(1), verifiedDouyinTopics: note.topics.slice(1) };
        expect(evaluateAudit(missing, context).topicsCompliant).toBe(false);
      });
    }
  }
  it("Douyin 只使用相同 contentId 的 statistics，忽略推荐、评论和缺失计数", () => {
    const item = { aweme_id: "current", statistics: { digg_count: 3, comment_count: 2, collect_count: 5 },
      recommendations: [{ statistics: { digg_count: 999 } }], comments: [{ digg_count: 999 }] };
    expect(extractDouyinInteraction(item, "current").totalCount).toBe(10);
    expect(extractDouyinInteraction(item, "other").totalCount).toBeNull();
    expect(extractDouyinInteraction({ ...item, statistics: { digg_count: 0, comment_count: 0, collect_count: 0 } }, "current").totalCount).toBe(0);
    expect(extractDouyinInteraction({ ...item, statistics: { digg_count: 3, comment_count: 2 } }, "current").favoriteCount).toBeNull();
    expect(extractDouyinPublicStatus({ ...item, status: { private_status: 0 } }, "current")).toBe(true);
    expect(extractDouyinPublicStatus({ ...item, status: { private_status: 1 } }, "current")).toBe(false);
    expect(extractDouyinPublicStatus({ ...item, status: { private_status: 0, is_private: true } }, "current")).toBe(false);
    expect(extractDouyinPublicStatus(item, "current")).toBeNull();
  });
  it("表格和详情渲染保存的12/10与六项数据", () => {
    const snapshot = evaluateInteractionReward({ likeCount: 5, commentCount: 3, favoriteCount: 4, interactionExtractionStatus: "SUCCESS" }, config);
    expect(interactionRewardPresentation(snapshot)?.compact).toBe("达标 12 / 10");
    const compact = renderToStaticMarkup(createElement(InteractionReward, { snapshot }));
    expect(compact).toContain("达标 12 / 10");
    const detail = renderToStaticMarkup(createElement(InteractionReward, { snapshot, detail: true }));
    for (const label of ["点赞", "评论", "收藏", "互动合计", "奖励门槛", "奖励结果"]) expect(detail).toContain(label);
    expect(renderToStaticMarkup(createElement(InteractionReward, { snapshot: { interactionRewardStatus: "NOT_ENABLED" } }))).toBe("");
  });
  it("规则包拒绝低版本或非法门槛，旧包默认为关闭", () => {
    expect(validateRulePayload(builtin).campaigns.every((campaign) => !campaign.interactionRewardEnabled)).toBe(true);
    const payload = { ...builtin, minimumAppVersion: "1.1.22", campaigns: builtin.campaigns.map((campaign) => ({ ...campaign, ...config })) };
    expect(validateRulePayload(payload).campaigns[0].interactionRewardThreshold).toBe(10);
    expect(() => validateRulePayload({ ...payload, minimumAppVersion: "1.1.21" })).toThrow("1.1.22");
    expect(() => validateRulePayload({ ...payload, campaigns: payload.campaigns.map((campaign) => ({ ...campaign, interactionRewardThreshold: 0 })) })).toThrow("正整数");
  });
  it("Excel和CSV附加六列，保留明确0与UNKNOWN空白，不导出枚举", async () => {
    const records = [{ likeCount: 0, commentCount: null, favoriteCount: 2, interactionTotal: null, interactionRewardThreshold: 10, interactionRewardStatus: "待确认" }];
    const input = { templates: BUILTIN_IMPORT_EXPORT_TEMPLATES, kind: "auditResults" as const, records };
    const csv = buildConfiguredCsv(input);
    expect(csv).toContain("互动奖励结果");
    expect(csv).toContain("待确认");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildConfiguredWorkbook(input));
    const sheet = workbook.worksheets[0];
    const headers = sheet.getRow(1).values as string[];
    expect(headers.filter((value) => value === "点赞数")).toHaveLength(1);
    expect(sheet.getRow(2).getCell(headers.indexOf("点赞数")).value).toBe(0);
    expect(sheet.getRow(2).getCell(headers.indexOf("评论数")).value).toBeNull();
  });
});

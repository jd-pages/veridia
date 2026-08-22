import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditDetailJsonForDisplay,
  auditDetailStatusLabel,
  filterAuditDetailReasons,
  filterAuditDetailRules,
  sanitizeAuditDetailEvidence,
} from "@/lib/audit-detail-visibility";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const forbiddenDetailTerms = [
  "发布时间",
  "作者",
  "15天留存",
  "留存计算",
  "正文段位校验",
  "不参与审核",
  "产品阶段仅用于匹配对应话题",
];

describe("审核详情展示过滤", () => {
  it("完整详情页和抽屉不直接渲染已隐藏字段或留存操作", () => {
    const detailPage = source("app/(admin)/results/[id]/page.tsx");
    const drawer = source("components/results/AuditDetailDrawer.tsx");
    const decision = source("components/results/AuditDecisionSummary.tsx");

    for (const text of [
      'label="作者"',
      'label="发布时间"',
      'label="15天留存"',
      'label="正文段位校验"',
      "不参与审核",
      "产品阶段仅用于匹配对应话题",
      "重新检查留存",
      "retention/recheck",
      "笔记基础信息",
      "笔记正文",
      "异常或失败原因",
      "自动取证证据",
    ]) {
      expect(detailPage).not.toContain(text);
      expect(drawer).not.toContain(text);
    }
    expect(detailPage).toContain("AuditDecisionSummary");
    expect(drawer).toContain("AuditDecisionSummary");
    expect(decision).toContain('aria-label="顶部结论"');
    expect(decision).toContain('aria-label="失败原因"');
    expect(decision).toContain('aria-label="审核明细"');
    expect(decision).toContain('aria-label="链接操作"');
    expect(decision).toContain('aria-label="人工复核记录"');
    expect(decision).toContain("resolveTaskChannel(row.task)");
    expect(decision).toContain("row.task.commercePlatform");
    expect(decision).toContain("row.task.storeName");
    expect(decision).toContain("row.task.orderNumber");
    expect(decision).toContain("formatAuditTime(row.auditedAt)");
    expect(decision).toContain("原始发布时间");
    expect(decision).not.toContain("原始时间来源");
    expect(decision).not.toContain("originalPublishedAtSourceLabel");
    expect(decision).toContain("row.note.originalPublishedAtStatus");
    expect(decision).toContain("平台显示时间");
    expect(decision).toContain("formatPlatformPublishedAt");
    expect(decision).toContain("row.note.publishedAtRaw");
    expect(decision).toContain("导入时间");
    expect(decision).toContain("实际审核时间");
    expect(decision).toContain("复制订单编号");
  });

  it("从逐条规则证据和失败原因中过滤隐藏项并保留真实审核项", () => {
    const rules = [
      { ruleKey: "PAGE_STATUS", ruleName: "页面状态", actualValue: "NORMAL" },
      { ruleKey: "BODY_LENGTH", ruleName: "正文有效字数", actualValue: "120" },
      { ruleKey: "IMAGE_COUNT", ruleName: "图片数量", actualValue: "4" },
      { ruleKey: "TOPIC_PRESENT", ruleName: "话题是否存在", actualValue: "是" },
      { ruleKey: "TOPIC_CLICKABLE", ruleName: "话题是否可点击", actualValue: "是" },
      { ruleKey: "GLOBAL_PUBLICATION", ruleName: "当前公开状态", actualValue: "公开" },
      { ruleKey: "AI_RELEVANCE", ruleName: "智能辅助状态", actualValue: "PASSED" },
      { ruleKey: "GLOBAL_RETENTION", ruleName: "15天留存", actualValue: "PENDING" },
      { ruleKey: "PRODUCT_STAGE_BODY", ruleName: "正文段位校验", actualValue: "通过" },
      { ruleKey: "LEGACY", ruleName: "留存计算", actualValue: "暂无结论" },
      { ruleKey: "LEGACY_DATE", ruleName: "发布时间", actualValue: "2026-08-01" },
    ];

    expect(filterAuditDetailRules(rules).map((rule) => rule.ruleKey)).toEqual([
      "PAGE_STATUS",
      "BODY_LENGTH",
      "IMAGE_COUNT",
      "TOPIC_PRESENT",
      "TOPIC_CLICKABLE",
      "GLOBAL_PUBLICATION",
      "AI_RELEVANCE",
    ]);
    expect(
      filterAuditDetailReasons([
        "图片数量不足",
        "15天留存：暂无结论",
        "正文段位校验不通过",
        "缺少必需话题",
      ]),
    ).toEqual(["图片数量不足", "缺少必需话题"]);
  });

  it("清理用户可展开的原始证据但保留真实审核字段", () => {
    const raw = {
      authorName: "测试作者",
      publishedAt: "2026-08-01T00:00:00.000Z",
      retentionStatus: "PENDING",
      retention: { dueAt: "2026-08-16" },
      bodyStage: "3",
      pageStatus: "NORMAL",
      imageCount: 4,
      topicCandidates: [{ value: "#京东", isLinkElement: true }],
      failureReasons: ["缺少必需话题", "留存计算：暂无结论"],
      ruleResults: [
        { ruleKey: "GLOBAL_RETENTION", ruleName: "15天留存", passed: true },
        { ruleKey: "IMAGE_COUNT", ruleName: "图片数量", passed: true },
      ],
    };
    const sanitized = sanitizeAuditDetailEvidence(raw);
    const serialized = JSON.stringify(sanitized);
    const displayJson = auditDetailJsonForDisplay(JSON.stringify(raw));

    for (const text of forbiddenDetailTerms) {
      expect(serialized).not.toContain(text);
      expect(displayJson).not.toContain(text);
    }
    expect(serialized).not.toContain("authorName");
    expect(serialized).not.toContain("publishedAt");
    expect(serialized).not.toContain("retentionStatus");
    expect(serialized).toContain('"pageStatus":"NORMAL"');
    expect(serialized).toContain('"imageCount":4');
    expect(serialized).toContain("#京东");
    expect(serialized).toContain("缺少必需话题");
    expect(serialized).not.toContain("GLOBAL_RETENTION");
    expect(serialized).toContain("IMAGE_COUNT");
  });

  it("详情状态不显示暂无结论", () => {
    expect(auditDetailStatusLabel("UNKNOWN")).toBe("待人工复核");
    expect(auditDetailStatusLabel("PENDING", "audit")).not.toContain("暂无结论");
  });

  it("保留底层字段、留存接口和产品阶段规则计算", () => {
    const retentionApi = source("app/api/results/[id]/retention/recheck/route.ts");
    const auditEngine = source("lib/audit-engine.ts");
    const schema = source("prisma/schema.prisma");

    expect(retentionApi).toContain("retention");
    expect(schema).toContain("retentionStatus");
    expect(schema).toContain("publishedAt");
    expect(schema).toContain("publishedAtRaw");
    expect(schema).toContain("publishedAtSource");
    expect(schema).toContain("authorName");
    expect(auditEngine).toContain('ruleKey: "PRODUCT_STAGE_BODY"');
    expect(auditEngine).toContain('ruleKey: "GLOBAL_RETENTION"');
  });

  it("平台发帖时间只来自自动提取负载，不使用 Excel 发帖时间补位", () => {
    const auditService = source("lib/audit-service.ts");
    expect(auditService).toContain("payload.publishedAt");
    expect(auditService).toContain("payload.publishedAtRaw");
    expect(auditService).toContain(
      "const auditedTopics = topicsForPlatformAudit(payload, contentChannel)",
    );
    expect(auditService).toContain("publishedAt: null");
    expect(auditService).not.toContain("importedPublishTimeValue");
    expect(auditService).not.toContain("importedMetadata.publishTime");
  });
});

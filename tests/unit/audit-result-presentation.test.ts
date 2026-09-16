import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildAuditResultPresentation,
  withAuditResultPresentation,
} from "@/lib/audit-result-presentation";
import { assertAuditEvaluationConsistency } from "@/lib/audit-evaluation-consistency";
import { detailedSelfReview } from "@/lib/import-export-templates/export";
import type { AuditEvaluation } from "@/lib/types";

const ruleSnapshot = JSON.stringify({
  minImageCount: 3,
  rules: [
    { id: "global", ruleType: "MUST_ALL", topicCategory: "BRAND_COMMON", topic: "#品牌" },
    { id: "product", ruleType: "MUST_ALL", topicCategory: "PRODUCT_COMMON", topic: "#产品" },
    { id: "stage", ruleType: "MUST_ALL", topicCategory: "PRODUCT_STAGE", topic: "#阶段A" },
  ],
});

function topicRule(
  id: string,
  topic: string,
  options: { passed?: boolean; clickability?: string } = {},
) {
  const passed = options.passed ?? true;
  return {
    ruleKey: `TOPIC_${id}`,
    ruleName: `必须话题 ${topic}`,
    expectedValue: "精确出现且为可点击话题",
    actualValue: passed ? "精确出现，可点击" : "未精确出现",
    passed,
    failureReason: passed ? null : `缺少精确话题 ${topic}`,
    evidence: JSON.stringify({
      expected: topic,
      dom: passed ? { finalClickability: options.clickability || "CLICKABLE" } : null,
    }),
  };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    autoStatus: "PASSED",
    pageStatus: "NORMAL",
    bodyStatus: "PRESENT",
    bodyCompliant: true,
    imageStatus: "COMPLIANT",
    imageCompliant: true,
    topicsCompliant: true,
    clickableCompliant: true,
    publicStatus: "PUBLIC",
    retentionStatus: "SATISFIED",
    failureReasons: "[]",
    missingTopics: "[]",
    forbiddenTopics: "[]",
    ruleSnapshot,
    evidenceStatus: "LEGACY_UNAVAILABLE" as const,
    evidenceMessage: "历史采集证据未能确认",
    note: { url: "https://www.xiaohongshu.com/explore/old", title: "旧标题", body: null, topics: [] },
    task: {
      notes: null,
      failureCode: null,
      failureMessage: null,
      pageTitle: null,
      pageType: null,
      product: { brandName: "达能" },
    },
    manualReviews: [],
    ruleResults: [
      topicRule("global", "#品牌"),
      topicRule("product", "#产品"),
      {
        ruleKey: "TOPIC_PRODUCT_STAGE_GROUP_IFFO",
        ruleName: "产品阶段话题 IFFO",
        expectedValue: "#阶段A、#阶段B 中任意 1 个，且可点击",
        actualValue: "已命中 #阶段A",
        passed: true,
        failureReason: null,
        evidence: JSON.stringify({
          expectedTopics: ["#阶段A", "#阶段B"],
          matchedTopics: ["#阶段A"],
          acceptedTopics: ["#阶段A"],
          candidates: [
            { topic: "#阶段A", present: true, clickability: "CLICKABLE" },
            { topic: "#阶段B", present: false, clickability: "UNKNOWN" },
          ],
        }),
      },
    ],
    ...overrides,
  };
}

describe("immutable audit result presentation", () => {
  it("Protected VIDEO_MEDIA_PRESENTATION_CONTRACT：历史绑定视频不会显示为零张图片", () => {
    const presentation = buildAuditResultPresentation(base({
      evidenceStatus: "RESULT_BOUND",
      noteType: "VIDEO",
      imageExtractionStatus: "VIDEO_NOTE",
      imageStatus: "NOT_REQUIRED",
      imageCompliant: null,
      imageCount: 0,
      note: { ...base().note, noteType: "VIDEO", pageType: "VIDEO_DETAIL" },
      task: { ...base().task, pageType: "VIDEO_DETAIL" },
    }));
    expect(presentation.media).toEqual({
      kind: "VIDEO",
      label: "视频作品",
      imageAuditApplicable: false,
      imageCount: null,
    });
    expect(presentation.image).toMatchObject({
      status: "VIDEO_NOTE",
      compliant: null,
      label: "视频作品，不参与图片数量审核",
    });
    expect(presentation.conclusion.label).toBe("审核通过");
  });

  it("图文继续使用历史图片数量和最低数量，证据不足不猜视频", () => {
    const compliant = buildAuditResultPresentation(base({
      noteType: "IMAGE_TEXT",
      imageCount: 4,
      note: { ...base().note, noteType: "IMAGE_TEXT" },
    }));
    expect(compliant.media).toMatchObject({ kind: "IMAGE_TEXT", imageCount: 4 });
    expect(compliant.image).toMatchObject({ label: "数量合规", minimumCount: 3 });

    const insufficient = buildAuditResultPresentation(base({
      autoStatus: "FAILED",
      noteType: "IMAGE_TEXT",
      imageCount: 2,
      imageStatus: "NON_COMPLIANT",
      imageCompliant: false,
      failureReasons: '["图片数量不足"]',
      note: { ...base().note, noteType: "IMAGE_TEXT" },
    }));
    expect(insufficient.media).toMatchObject({ kind: "IMAGE_TEXT", imageCount: 2 });
    expect(insufficient.image).toMatchObject({ label: "数量不足", minimumCount: 3 });

    const unknown = buildAuditResultPresentation(base({
      imageStatus: "NOT_REQUIRED",
      imageCompliant: null,
      imageCount: 0,
    }));
    expect(unknown.media.kind).toBe("UNKNOWN");
    expect(unknown.image.status).toBe("NOT_CHECKED");
  });
  it("Protected STORE_TOPIC_BRAND_SCOPE：雀巢和惠氏历史店铺话题误判只在展示层归一化", () => {
    const storeFailure = {
      ruleKey: "STORE_TOPIC",
      ruleName: "店铺话题审核",
      expectedValue: "#FOLO海外专营店",
      actualValue: "未命中",
      passed: false,
      failureReason: "未命中任何可接受店铺话题：#FOLO海外专营店",
      evidence: JSON.stringify({ status: "NON_COMPLIANT" }),
    };
    for (const brandName of ["雀巢", "惠氏"] as const) {
      const row = base({
        autoStatus: "FAILED",
        topicsCompliant: false,
        storeTopicStatus: "NON_COMPLIANT",
        storeTopicFailureReason: storeFailure.failureReason,
        failureReasons: JSON.stringify([storeFailure.failureReason]),
        task: { ...base().task, product: { brandName } },
        ruleResults: [...base().ruleResults, storeFailure],
      });
      const original = structuredClone(row);
      const presentation = buildAuditResultPresentation(row);
      expect(presentation.automaticConclusion.status).toBe("PASSED");
      expect(presentation.storeTopic).toEqual({
        applicable: false,
        status: "NOT_APPLICABLE",
        label: "不适用",
      });
      expect(presentation.failureReasons).toEqual([]);
      expect(detailedSelfReview({
        ...row,
        presentation,
        manualReviews: [],
      } as never)).toBe("Y");
      expect(row).toEqual(original);
    }
  });

  it("非适用品牌仍保留正文失败与真实 UNKNOWN", () => {
    const common = {
      storeTopicStatus: "NON_COMPLIANT",
      storeTopicFailureReason: "未命中任何可接受店铺话题：#BJF海外专营店",
      task: { ...base().task, product: { brandName: "雀巢" } },
      ruleResults: [
        ...base().ruleResults,
        {
          ruleKey: "STORE_TOPIC",
          ruleName: "店铺话题审核",
          expectedValue: "#BJF海外专营店",
          actualValue: "未命中",
          passed: false,
          failureReason: "未命中任何可接受店铺话题：#BJF海外专营店",
          evidence: "{}",
        },
      ],
    };
    const bodyFailed = buildAuditResultPresentation(base({
      ...common,
      autoStatus: "FAILED",
      bodyCompliant: false,
      failureReasons: JSON.stringify([
        "未命中任何可接受店铺话题：#BJF海外专营店",
        "有效正文字数不足：要求至少 100 个，实际 20 个",
      ]),
    }));
    expect(bodyFailed.automaticConclusion.status).toBe("FAILED");
    expect(bodyFailed.failureReasons).toEqual([
      "正文字数不足：当前 20 字，要求 ≥100 字",
    ]);

    const trueUnknown = buildAuditResultPresentation(base({
      ...common,
      autoStatus: "NEEDS_REVIEW",
      publicStatus: "UNKNOWN",
      failureReasons: JSON.stringify([
        "未命中任何可接受店铺话题：#BJF海外专营店",
      ]),
    }));
    expect(trueUnknown.automaticConclusion.status).toBe("NEEDS_REVIEW");
    expect(trueUnknown.reviewReasons).toContain("公开状态待确认");
  });

  it("uses complete persisted RuleResults for a legacy extraction instead of showing 0/N", () => {
    const presentation = buildAuditResultPresentation(base());

    expect(presentation.topic).toMatchObject({
      source: "PERSISTED_RULE_RESULTS",
      status: "COMPLIANT",
      expectedCount: 3,
      matchedCount: 3,
    });
    expect(presentation.consistency.status).toBe("CONSISTENT");
    expect(presentation.conclusion.label).toBe("审核通过");
  });

  it("does not let a latest Note or latest rules projection mutate the saved result", () => {
    const persisted = base({
      currentNote: { topics: [] },
      currentRules: [{ id: "replacement", topic: "#新规则" }],
    });
    const changedCurrentProjection = {
      ...persisted,
      currentNote: { topics: ["#任意新话题"] },
      currentRules: [],
    };

    expect(buildAuditResultPresentation(persisted)).toEqual(
      buildAuditResultPresentation(changedCurrentProjection),
    );
  });

  it("marks truly incomplete legacy topic evidence unavailable instead of recomputing", () => {
    const presentation = buildAuditResultPresentation(base({ ruleResults: [] }));

    expect(presentation.topic).toMatchObject({
      source: "LEGACY_UNAVAILABLE",
      status: "UNAVAILABLE",
      expectedCount: 3,
      matchedCount: 0,
    });
    expect(presentation.consistency.status).toBe("HISTORICAL_LEGACY_INCOMPLETE");
  });

  it("fails closed when a saved PASSED conclusion contradicts a failed mandatory rule", () => {
    const row = base({
      topicsCompliant: false,
      missingTopics: '["#产品"]',
      ruleResults: [
        topicRule("global", "#品牌"),
        topicRule("product", "#产品", { passed: false }),
        base().ruleResults[2],
      ],
    });
    const presentation = buildAuditResultPresentation(row);

    expect(presentation.consistency.status).toBe("RESULT_CONSISTENCY_VIOLATION");
    expect(presentation.automaticConclusion).toMatchObject({
      status: "NEEDS_REVIEW",
      label: "结果一致性异常",
      tone: "warning",
    });
    expect(detailedSelfReview({
      ...row,
      presentation,
      manualReviews: [],
    } as never)).toContain("N-结果一致性异常");
  });

  it("does not treat an unknown optional diagnostic as a mandatory contradiction", () => {
    const presentation = buildAuditResultPresentation(base({
      ruleResults: [
        ...base().ruleResults,
        {
          ruleKey: "OPTIONAL_DIAGNOSTIC",
          ruleName: "可选诊断",
          expectedValue: "仅记录",
          actualValue: "未命中",
          passed: false,
          failureReason: null,
          evidence: "{}",
        },
      ],
    }));

    expect(presentation.consistency.status).toBe("CONSISTENT");
    expect(presentation.automaticConclusion.label).toBe("审核通过");
  });

  it("normalizes legacy retention-only NEEDS_REVIEW to PASSED", () => {
    const presentation = buildAuditResultPresentation(base({
      autoStatus: "NEEDS_REVIEW",
      retentionStatus: "PENDING",
      ruleResults: [
        ...base().ruleResults,
        {
          ruleKey: "GLOBAL_RETENTION",
          ruleName: "公开留存",
          expectedValue: "公开保留至少 7 天",
          actualValue: "待验证",
          passed: true,
          failureReason: null,
          evidence: JSON.stringify({ dueAt: "2026-09-20T00:00:00.000Z" }),
        },
      ],
    }));

    expect(presentation.consistency.status).toBe("CONSISTENT");
    expect(presentation.automaticConclusion).toMatchObject({
      status: "PASSED",
      label: "审核通过",
      tone: "success",
    });
    expect(presentation.failureReasons).toEqual([]);
    expect(presentation.reviewReasons).toEqual([]);
    expect(presentation.pendingReasons).toEqual([]);
    expect(presentation.isManualReviewRequired).toBe(false);
    expect(presentation.retentionDisplay).toMatchObject({
      label: "不要求",
      dueAt: null,
    });

    const pendingEra = buildAuditResultPresentation(base({
      autoStatus: "PENDING_RETENTION",
      retentionStatus: "PENDING",
    }));
    expect(pendingEra.automaticConclusion.status).toBe("PASSED");
  });

  it("keeps true review evidence dominant while retention remains separately pending", () => {
    const presentation = buildAuditResultPresentation(base({
      autoStatus: "NEEDS_REVIEW",
      retentionStatus: "PENDING",
      retentionDueAt: "2026-09-20T00:00:00.000Z",
      publicStatus: "UNKNOWN",
    }));
    expect(presentation.automaticConclusion.status).toBe("NEEDS_REVIEW");
    expect(presentation.isManualReviewRequired).toBe(true);
    expect(presentation.reviewReasons).toContain("公开状态待确认");
    expect(presentation.retentionDisplay.label).toBe("不要求");
  });

  it("lets manual review override the main conclusion without changing automatic evidence", () => {
    const presentation = buildAuditResultPresentation(base({
      manualReviews: [{ result: "FAILED" }],
    }));

    expect(presentation.conclusion).toMatchObject({
      status: "FAILED",
      label: "人工不通过",
      source: "MANUAL",
    });
    expect(presentation.automaticConclusion.label).toBe("审核通过");
    expect(presentation.topic.matchedCount).toBe(3);
  });

  it("produces the same projection for list, detail and export consumers", () => {
    const row = base();
    const list = withAuditResultPresentation(row).presentation;
    const detail = withAuditResultPresentation({ ...row }).presentation;
    const exportPresentation = withAuditResultPresentation({ ...row }).presentation;

    expect(detail).toEqual(list);
    expect(exportPresentation).toEqual(list);
  });

  it("wires list detail export and result cells to the shared presentation contract", () => {
    const source = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
    for (const file of [
      "app/api/results/route.ts",
      "app/api/results/[id]/route.ts",
      "app/api/results/export/route.ts",
    ]) {
      expect(source(file)).toContain("withAuditResultPresentation");
    }
    for (const file of [
      "components/results/TopicAuditCell.tsx",
      "components/results/ImageAuditCell.tsx",
      "components/results/AuditConclusionCell.tsx",
      "components/results/AuditDecisionSummary.tsx",
      "app/(admin)/results/page.tsx",
    ]) {
      expect(source(file)).toContain("row.presentation");
    }
    expect(source("components/results/TopicAuditCell.tsx"))
      .not.toMatch(/topicAuditRuleSummary|classifyTopicCandidates/u);
  });
});

describe("audit evaluation persistence invariant", () => {
  const evaluation = {
    pageStatus: "NORMAL",
    bodyStatus: "PRESENT",
    effectiveBodyLength: 100,
    bodyCompliant: true,
    noteType: "IMAGE_TEXT",
    imageExtractionStatus: "SUCCESS",
    imageStatus: "COMPLIANT",
    imageCount: 3,
    imageCompliant: true,
    topicsCompliant: true,
    clickableCompliant: true,
    storeTopicStatus: "NOT_REQUIRED",
    expectedStoreTopic: null,
    expectedStoreTopics: [],
    requiredStoreTopics: [],
    matchedStoreTopic: null,
    matchedStoreTopics: [],
    matchedRequiredStoreTopics: [],
    storeTopicFailureReason: null,
    publicStatus: "PUBLIC",
    retentionStatus: "SATISFIED",
    missingTopics: [],
    forbiddenTopics: [],
    autoStatus: "PASSED",
    failureReasons: [],
    ruleResults: [{
      ruleKey: "GLOBAL_BODY",
      ruleName: "正文",
      expectedValue: "存在",
      actualValue: "存在",
      passed: true,
      evidence: {},
    }],
  } satisfies AuditEvaluation;

  it("accepts a consistent evaluation", () => {
    expect(() => assertAuditEvaluationConsistency(evaluation)).not.toThrow();
  });

  it("rejects PASSED with a failed mandatory fact", () => {
    expect(() => assertAuditEvaluationConsistency({
      ...evaluation,
      topicsCompliant: false,
    })).toThrow(/AUDIT_EVALUATION_INCONSISTENT/u);
  });

  it("rejects PASSED with a failed persisted basic reward", () => {
    expect(() => assertAuditEvaluationConsistency({
      ...evaluation,
      ruleResults: [{
        ruleKey: "KABRITA_BASIC_REWARD",
        ruleName: "佳贝艾特基础奖励",
        expectedValue: "互动量 >= 10",
        actualValue: "互动量 9",
        passed: false,
        failureReason: "基础奖励未达成",
        evidence: {},
      }],
    })).toThrow(/AUDIT_EVALUATION_INCONSISTENT/u);
  });

  it("accepts PASSED when retention is pending information", () => {
    expect(() => assertAuditEvaluationConsistency({
      ...evaluation,
      autoStatus: "PASSED",
      retentionStatus: "PENDING",
    })).not.toThrow();
  });

  it("rejects NEEDS_REVIEW when retention pending is the only signal", () => {
    expect(() => assertAuditEvaluationConsistency({
      ...evaluation,
      autoStatus: "NEEDS_REVIEW",
      retentionStatus: "PENDING",
    })).toThrow(/缺少复核信号/u);
  });

  it("rejects NEEDS_REVIEW without any review signal", () => {
    expect(() => assertAuditEvaluationConsistency({
      ...evaluation,
      autoStatus: "NEEDS_REVIEW",
    })).toThrow(/缺少复核信号/u);
  });
});

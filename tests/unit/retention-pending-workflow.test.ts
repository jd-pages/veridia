import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deriveAuditBusinessStatus } from "@/lib/retention-pending-classification";
import { evaluateRetentionStatus } from "@/lib/retention-status";
import { buildAuditResultWhere } from "@/lib/result-query";
import { summarizeResultStatusGroups } from "@/lib/result-summary";

function input(overrides: Record<string, unknown> = {}) {
  return {
    autoStatus: "NEEDS_REVIEW",
    pageStatus: "NORMAL",
    bodyStatus: "PRESENT",
    bodyCompliant: true,
    imageStatus: "COMPLIANT",
    imageCompliant: true,
    topicsCompliant: true,
    clickableCompliant: true,
    publicStatus: "PUBLIC",
    retentionStatus: "PENDING",
    storeTopicStatus: "COMPLIANT",
    interactionRewardStatus: "NOT_ENABLED",
    failureReasons: "[]",
    ruleResults: [],
    ...overrides,
  };
}

describe("retention is information-only", () => {
  it("Protected RETENTION_DOES_NOT_AFFECT_AUDIT_DECISION：留存不改变结论、人工队列、展示、导出或后台调度", () => {
    expect(deriveAuditBusinessStatus(input())).toBe("PASSED");
    expect(deriveAuditBusinessStatus(input({ retentionStatus: "UNKNOWN" })))
      .toBe("PASSED");
    expect(deriveAuditBusinessStatus(input({ autoStatus: "PENDING_RETENTION" })))
      .toBe("PASSED");
    expect(deriveAuditBusinessStatus(input({ publicStatus: "UNKNOWN" })))
      .toBe("NEEDS_REVIEW");
    expect(deriveAuditBusinessStatus(input({
      ruleResults: [{
        ruleKey: "TOPIC_TECHNICAL_READ",
        actualValue: "UNKNOWN",
        evidence: "{}",
        passed: true,
      }],
    }))).toBe("NEEDS_REVIEW");
    expect(deriveAuditBusinessStatus(input({ topicsCompliant: false })))
      .toBe("FAILED");

    const classification = {
      normalizedPassIds: ["legacy-pass"],
      normalizedManualReviewIds: ["legacy-review"],
      normalizedFailedIds: ["legacy-failed"],
    };
    const evidence = {
      keywordIds: [],
      processingFailureIds: [],
      retentionClassification: classification,
    };
    const passedQuery = JSON.stringify(
      buildAuditResultWhere({ status: "PASSED" }, evidence),
    );
    const reviewQuery = JSON.stringify(
      buildAuditResultWhere({ status: "NEEDS_REVIEW" }, evidence),
    );
    const legacyPendingQuery = JSON.stringify(
      buildAuditResultWhere({ status: "PENDING_RETENTION" }, evidence),
    );
    expect(passedQuery).toContain("legacy-pass");
    expect(reviewQuery).toContain("legacy-review");
    expect(reviewQuery).toContain('"notIn":["legacy-pass","legacy-failed"]');
    expect(legacyPendingQuery).toContain('"in":[]');

    expect(summarizeResultStatusGroups([
      { autoStatus: "PASSED", pageStatus: "NORMAL", _count: { _all: 1 } },
      { autoStatus: "FAILED", pageStatus: "NORMAL", _count: { _all: 1 } },
      { autoStatus: "NEEDS_REVIEW", pageStatus: "NORMAL", _count: { _all: 1 } },
      { autoStatus: "PENDING_RETENTION", pageStatus: "NORMAL", _count: { _all: 1 } },
    ], 0, { passed: { PENDING_RETENTION: 1 } })).toMatchObject({
      total: 4,
      passed: 2,
      failed: 1,
      review: 1,
    });

    const queue = fs.readFileSync(path.resolve("lib/automation/queue.ts"), "utf8");
    const health = fs.readFileSync(path.resolve("app/api/health/route.ts"), "utf8");
    const listUi = fs.readFileSync(path.resolve("components/results/ResultSummaryCards.tsx"), "utf8");
    const detailUi = fs.readFileSync(path.resolve("components/results/AuditDecisionSummary.tsx"), "utf8");
    const exportSource = fs.readFileSync(path.resolve("lib/import-export-templates/export.ts"), "utf8");
    expect(fs.existsSync(path.resolve("lib/automation/retention-recheck.ts"))).toBe(false);
    expect(`${queue}\n${health}`).not.toMatch(/RetentionRecheck|retention-recheck/u);
    expect(`${listUi}\n${detailUi}`).not.toMatch(/待留存验证|公开留存|留存到期/u);
    expect(exportSource).not.toContain('return "待留存验证"');
  });

  it("time advancing past retentionDueAt does not activate a scheduler", () => {
    const queue = fs.readFileSync(path.resolve("lib/automation/queue.ts"), "utf8");
    const health = fs.readFileSync(path.resolve("app/api/health/route.ts"), "utf8");
    expect(queue).not.toMatch(/retentionDueAt|RETENTION_RECHECK/u);
    expect(health).not.toMatch(/retentionDueAt|RETENTION_RECHECK/u);
  });

  it("keeps retention calculation as compatible informational evidence", () => {
    const publishedAt = new Date("2026-08-31T14:31:44.000Z");
    const dueAt = Date.parse("2026-09-15T14:31:44.000Z");
    expect(evaluateRetentionStatus({
      publicStatus: "PUBLIC", retentionDays: 15, publishedAt,
      now: new Date(dueAt - 1),
    }).retentionStatus).toBe("PENDING");
    expect(evaluateRetentionStatus({
      publicStatus: "PUBLIC", retentionDays: 15, publishedAt,
      now: new Date(dueAt),
    }).retentionStatus).toBe("SATISFIED");
  });
});

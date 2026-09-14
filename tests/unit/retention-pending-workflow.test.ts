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

describe("retention pending business workflow", () => {
  it("Protected RETENTION_PENDING_NOT_MANUAL_REVIEW：留存待到期独立于失败、人工复核、查询和不可变复查", () => {
    expect(deriveAuditBusinessStatus(input())).toBe("PENDING_RETENTION");
    expect(deriveAuditBusinessStatus(input({ publicStatus: "UNKNOWN" })))
      .toBe("NEEDS_REVIEW");
    expect(deriveAuditBusinessStatus(input({ retentionStatus: "UNKNOWN" })))
      .toBe("NEEDS_REVIEW");
    expect(deriveAuditBusinessStatus(input({ clickableCompliant: false })))
      .toBe("FAILED");
    expect(deriveAuditBusinessStatus(input({ bodyCompliant: false })))
      .toBe("FAILED");

    const pendingQuery = JSON.stringify(
      buildAuditResultWhere({ status: "PENDING_RETENTION" }),
    );
    const reviewQuery = JSON.stringify(
      buildAuditResultWhere({ status: "NEEDS_REVIEW" }),
    );
    expect(pendingQuery).toContain('"retentionStatus":"PENDING"');
    expect(reviewQuery).toContain('"NOT":{"AND"');

    expect(summarizeResultStatusGroups([
      { autoStatus: "PASSED", pageStatus: "NORMAL", _count: { _all: 2 } },
      { autoStatus: "NEEDS_REVIEW", pageStatus: "NORMAL", _count: { _all: 2 } },
      { autoStatus: "PENDING_RETENTION", pageStatus: "NORMAL", _count: { _all: 1 } },
    ], 0, { PASSED: 1, NEEDS_REVIEW: 1 })).toMatchObject({
      passed: 1,
      review: 1,
      pendingRetention: 3,
    });

    const scheduler = fs.readFileSync(
      path.resolve("lib/automation/retention-recheck.ts"),
      "utf8",
    );
    expect(scheduler).toContain("replacesResultId");
    expect(scheduler).toContain("createAutomaticBatchInTransaction");
    expect(scheduler).toContain("resolveRetentionBusinessClassificationIds");
    expect(scheduler).toContain("retentionClassification.pendingIds");
    expect(scheduler).not.toMatch(/updateMany\([\s\S]*auditResult/iu);
  });

  it("compares due boundaries by absolute milliseconds", () => {
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
    expect(evaluateRetentionStatus({
      publicStatus: "PUBLIC", retentionDays: 15, publishedAt,
      now: new Date(dueAt + 1),
    }).retentionStatus).toBe("SATISFIED");
  });
});

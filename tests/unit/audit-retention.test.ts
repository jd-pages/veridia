import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import type { AuditContext } from "@/lib/types";

const context: AuditContext = {
  productId: "product", campaignId: "july", campaignName: "旧活动",
  ruleVersion: 1, minImageCount: 2, minBodyLength: 21, bodyRequired: true,
  publicRequired: true, retentionDays: 15, clickableTopicRequired: true,
  interactionRewardEnabled: false, interactionRewardThreshold: 0, rules: [],
};

describe("公开留存与旧活动奖励兼容", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-07T08:30:00.000Z")); });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["2026-07-08T08:30:00.000Z", true, "PUBLIC", "SATISFIED", "PASSED"],
    ["2026-09-01T08:30:00.000Z", true, "PUBLIC", "PENDING", "NEEDS_REVIEW"],
    [null, true, "PUBLIC", "PENDING", "NEEDS_REVIEW"],
    ["invalid", true, "PUBLIC", "PENDING", "NEEDS_REVIEW"],
    ["2026-07-08T08:30:00.000Z", false, "NOT_PUBLIC", "NOT_SATISFIED", "FAILED"],
    ["2026-07-08T08:30:00.000Z", null, "UNKNOWN", "PENDING", "NEEDS_REVIEW"],
    ["2026-08-23T08:30:00.000Z", true, "PUBLIC", "SATISFIED", "PASSED"],
    ["2026-08-23T08:30:00.001Z", true, "PUBLIC", "PENDING", "NEEDS_REVIEW"],
  ] as const)("%s / public=%s => %s / %s / %s", (publishedAt, isPublic, publicStatus, retentionStatus, autoStatus) => {
    const result = evaluateAudit({ ...createMockNote("passed"), publishedAt, isPublic }, context);
    expect(result).toMatchObject({ publicStatus, retentionStatus, autoStatus });
    if (publishedAt === "2026-07-08T08:30:00.000Z" && isPublic) expect(result.retentionDueAt).toBe("2026-07-23T08:30:00.000Z");
  });

  it("interactionRewardEnabled=false 时 UNKNOWN 互动不改变旧活动结论、失败原因或留存", () => {
    const note = { ...createMockNote("passed"), publishedAt: "2026-07-08T08:30:00.000Z", isPublic: true };
    const known = evaluateAudit({ ...note, likeCount: 3, commentCount: 2, favoriteCount: 5, interactionExtractionStatus: "SUCCESS" }, context);
    const unknown = evaluateAudit({ ...note, likeCount: null, commentCount: null, favoriteCount: null, interactionExtractionStatus: "UNAVAILABLE" }, context);
    expect(unknown).toMatchObject({ autoStatus: "PASSED", retentionStatus: "SATISFIED", failureReasons: [] });
    expect(unknown.autoStatus).toBe(known.autoStatus);
    expect(unknown.failureReasons).toEqual(known.failureReasons);
    expect(unknown.interactionReward?.interactionRewardStatus).toBe("NOT_ENABLED");
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveRuleCountsFromState } from "@/lib/rules/status-counts";

const coreCounts = {
  products: 11,
  activities: 12,
  stageGroups: 3,
  topicRules: 81,
};

describe("Rule Sync status counts", () => {
  it("uses complete countsJson without querying the database fallback", async () => {
    const fallback = vi.fn(async () => ({
      storeTopicRules: 99,
      storeAliases: 88,
    }));

    await expect(resolveRuleCountsFromState(JSON.stringify({
      ...coreCounts,
      storeTopicRules: 45,
      storeAliases: 9,
    }), fallback)).resolves.toEqual({
      ...coreCounts,
      storeTopicRules: 45,
      storeAliases: 9,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("fills store counts from current data for legacy four-field state", async () => {
    const fallback = vi.fn(async () => ({
      storeTopicRules: 3,
      storeAliases: 2,
    }));

    await expect(resolveRuleCountsFromState(
      JSON.stringify(coreCounts),
      fallback,
    )).resolves.toEqual({
      ...coreCounts,
      storeTopicRules: 3,
      storeAliases: 2,
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("preserves a legitimate zero-store database result", async () => {
    await expect(resolveRuleCountsFromState(
      JSON.stringify(coreCounts),
      async () => ({ storeTopicRules: 0, storeAliases: 0 }),
    )).resolves.toEqual({
      ...coreCounts,
      storeTopicRules: 0,
      storeAliases: 0,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import builtinRules from "@/rules/default-rules.json";
import { validateRulePayload } from "@/lib/rules/package";

const mocks = vi.hoisted(() => ({
  productFindUnique: vi.fn(),
  productFindFirst: vi.fn(),
  campaignFindUnique: vi.fn(),
  campaignCreate: vi.fn(),
  topicRuleFindUnique: vi.fn(),
  topicRuleCreate: vi.fn(),
  productCount: vi.fn(),
  campaignCount: vi.fn(),
  stageGroupCount: vi.fn(),
  topicRuleCount: vi.fn(),
  syncUpdateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    product: {
      findUnique: mocks.productFindUnique,
      findFirst: mocks.productFindFirst,
      count: mocks.productCount,
    },
    campaign: {
      findUnique: mocks.campaignFindUnique,
      create: mocks.campaignCreate,
      count: mocks.campaignCount,
    },
    topicRule: {
      findUnique: mocks.topicRuleFindUnique,
      create: mocks.topicRuleCreate,
      count: mocks.topicRuleCount,
    },
    ruleStageGroup: { count: mocks.stageGroupCount },
    ruleSyncState: { updateMany: mocks.syncUpdateMany },
  },
}));

import { ensureBuiltinDouyinRules } from "@/lib/rules/douyin-initialization";

describe("抖音规则持久化幂等性", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.productFindUnique.mockImplementation(({ where }) =>
      Promise.resolve({ id: `db-${where.publishedKey}` }),
    );
    mocks.campaignFindUnique.mockImplementation(({ where }) =>
      Promise.resolve({ id: `db-${where.publishedKey}` }),
    );
    mocks.topicRuleFindUnique.mockResolvedValue({ id: "existing-rule" });
    mocks.productCount.mockResolvedValue(7);
    mocks.campaignCount.mockResolvedValue(6);
    mocks.stageGroupCount.mockResolvedValue(3);
    mocks.topicRuleCount.mockResolvedValue(54);
    mocks.syncUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("重复初始化不创建重复副本也不覆盖管理员修改", async () => {
    const result = await ensureBuiltinDouyinRules(
      validateRulePayload(builtinRules),
    );

    expect(result).toMatchObject({
      sourceCampaigns: 3,
      expectedTopicRules: 26,
      createdCampaigns: 0,
      createdTopicRules: 0,
      createdProductRelations: 0,
    });
    expect(mocks.campaignCreate).not.toHaveBeenCalled();
    expect(mocks.topicRuleCreate).not.toHaveBeenCalled();
  });
});

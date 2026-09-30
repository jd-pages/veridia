import { describe, expect, it } from "vitest";
import { normalizeInteractionRewardTiers, resolveCampaignRewardConfig, legacyBasicRewardRequired } from "@/lib/campaign-reward-config";
import { validateRulePayload } from "@/lib/rules/package";
import builtin from "@/rules/default-rules.json";

describe("Campaign reward configuration and rules compatibility", () => {
  it("档位升序、正整数且门槛唯一；非法配置不静默猜模式", () => {
    expect(normalizeInteractionRewardTiers([{ threshold: 40, amount: 50 }, { threshold: 10, amount: 20 }]))
      .toEqual([{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }]);
    for (const value of [null, "[]", [{ threshold: 0, amount: 20 }], [{ threshold: 1.5, amount: 20 }],
      [{ threshold: 10, amount: -1 }], [{ threshold: 10, amount: "20" }], [{ threshold: 10, amount: 20 }, { threshold: 10, amount: 50 }]]) {
      expect(() => normalizeInteractionRewardTiers(value)).toThrow();
    }
    expect(() => resolveCampaignRewardConfig({ rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS" })).toThrow("至少需要一个");
    expect(() => resolveCampaignRewardConfig({ rewardMode: "UNKNOWN" })).toThrow("模式");
    expect(resolveCampaignRewardConfig({ interactionRewardTiers: [{ threshold: 10, amount: 20 }] }).rewardMode).toBe("LEGACY");
  });

  it("旧包可读且旧基础门槛只对原精确predicate物化", () => {
    expect(validateRulePayload(builtin).campaigns.every((campaign) => campaign.rewardMode === undefined)).toBe(true);
    const old = { name: "佳贝艾特2026年8月小红书种草审核", brandNames: ["佳贝艾特"], contentChannel: "XIAOHONGSHU" };
    expect(legacyBasicRewardRequired(old)).toBe(true);
    for (const input of [{ ...old, name: "佳贝艾特2026年9月小红书种草审核" }, { ...old, contentChannel: "DOUYIN" }, { ...old, brandNames: ["达能"] }]) {
      expect(legacyBasicRewardRequired(input)).toBe(false);
    }
    expect(resolveCampaignRewardConfig({}, { basicRewardRequired: true })).toMatchObject({ rewardMode: "LEGACY", basicRewardRequired: true, interactionRewardTiers: [] });
  });

  it("带新奖励能力包必须min41，旧单档包仍接受原版本", () => {
    const campaigns = builtin.campaigns.map((campaign) => ({ ...campaign, rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS",
      basicRewardRequired: false, baseRewardAmount: 50, interactionRewardTiers: [{ threshold: 40, amount: 50 }, { threshold: 10, amount: 20 }] }));
    expect(() => validateRulePayload({ ...builtin, minimumAppVersion: "1.1.40", campaigns })).toThrow("1.1.41");
    expect(validateRulePayload({ ...builtin, minimumAppVersion: "1.1.41", campaigns }).campaigns[0].interactionRewardTiers)
      .toEqual([{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }]);
    const legacy = builtin.campaigns.map((campaign) => ({ ...campaign, interactionRewardEnabled: true, interactionRewardThreshold: 10 }));
    expect(validateRulePayload({ ...builtin, minimumAppVersion: "1.1.22", campaigns: legacy }).campaigns[0].interactionRewardThreshold).toBe(10);
  });
});

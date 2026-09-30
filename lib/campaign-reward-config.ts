import type { InteractionRewardTier, RewardMode } from "@/lib/interaction-reward";

export interface CampaignRewardConfig {
  rewardMode: RewardMode;
  basicRewardRequired: boolean;
  baseRewardAmount: number;
  interactionRewardEnabled: boolean;
  interactionRewardThreshold: number;
  interactionRewardTiers: InteractionRewardTier[];
}

const validInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;

/** Validate once for API and rules packages; persisted ordering is canonical. */
export function normalizeInteractionRewardTiers(value: unknown): InteractionRewardTier[] {
  if (!Array.isArray(value)) throw new Error("互动奖励档位必须为数组");
  const thresholds = new Set<number>();
  const tiers = value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("互动奖励档位无效");
    const { threshold, amount } = item as Record<string, unknown>;
    if (!validInteger(threshold) || (threshold as number) === 0 || !validInteger(amount)) {
      throw new Error("互动奖励门槛必须为正整数，金额必须为非负整数");
    }
    if (thresholds.has(threshold as number)) throw new Error("互动奖励档位门槛不能重复");
    thresholds.add(threshold as number);
    return { threshold: threshold as number, amount: amount as number };
  });
  return tiers.sort((left, right) => left.threshold - right.threshold);
}

/** Used only when materializing old campaign inputs, never during audit. */
export function legacyBasicRewardRequired(input: {
  name: string;
  contentChannel?: string;
  brandNames: string[];
}) {
  return (input.contentChannel || "XIAOHONGSHU") === "XIAOHONGSHU" &&
    input.name === "佳贝艾特2026年8月小红书种草审核" &&
    input.brandNames.some((brand) => brand.trim() === "佳贝艾特");
}

export function resolveCampaignRewardConfig(
  input: Record<string, unknown>,
  current?: Partial<CampaignRewardConfig>,
): CampaignRewardConfig {
  const field = (key: keyof CampaignRewardConfig, fallback: unknown) =>
    input[key] !== undefined ? input[key] : current?.[key] ?? fallback;
  const rewardMode = field("rewardMode", "LEGACY");
  const basicRewardRequired = field("basicRewardRequired", false);
  const baseRewardAmount = field("baseRewardAmount", 0);
  const interactionRewardEnabled = field("interactionRewardEnabled", false);
  const interactionRewardThreshold = field("interactionRewardThreshold", 0);
  if (rewardMode !== "LEGACY" && rewardMode !== "CONTENT_BASE_PLUS_INTERACTION_TIERS") {
    throw new Error("奖励模式无效");
  }
  if (typeof basicRewardRequired !== "boolean" || typeof interactionRewardEnabled !== "boolean") {
    throw new Error("奖励开关必须为布尔值");
  }
  if (!validInteger(baseRewardAmount) || !validInteger(interactionRewardThreshold)) {
    throw new Error("基础奖励金额和互动门槛必须为非负整数");
  }
  if (rewardMode === "LEGACY" && interactionRewardEnabled && interactionRewardThreshold === 0) {
    throw new Error("互动奖励启用时门槛必须为正整数");
  }
  const interactionRewardTiers = normalizeInteractionRewardTiers(
    field("interactionRewardTiers", []),
  );
  if (rewardMode === "CONTENT_BASE_PLUS_INTERACTION_TIERS" && !interactionRewardTiers.length) {
    throw new Error("阶梯奖励模式至少需要一个互动奖励档位");
  }
  return {
    rewardMode, basicRewardRequired, baseRewardAmount: baseRewardAmount as number,
    interactionRewardEnabled, interactionRewardThreshold: interactionRewardThreshold as number,
    interactionRewardTiers,
  };
}

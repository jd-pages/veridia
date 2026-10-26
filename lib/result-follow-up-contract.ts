import { z } from "zod";
import type { AuditContext } from "@/lib/types";

export const FOLLOW_UP_SOURCES = ["RESULT_DATA_SUPPLEMENT", "RESULT_RETENTION_RECHECK"] as const;
export const isResultFollowUpSource = (source: string) =>
  FOLLOW_UP_SOURCES.some((value) => value === source);

const integer = z.number().int().nonnegative();
const contractSchema = z.object({
  productId: z.string().min(1), campaignId: z.string().min(1), campaignName: z.string(),
  contentChannel: z.literal("XIAOHONGSHU"), ruleMonth: z.string().regex(/^\d{4}-\d{2}$/u),
  brandName: z.string().min(1), rulesConfigured: z.literal(true), ruleVersion: integer,
  rewardMode: z.enum(["CONTENT_BASE_PLUS_INTERACTION_TIERS", "LEGACY"]),
  // Missing-data acquisition does not require an active retention policy.
  // Preserve zero exactly; it must not acquire a new 30-day/reward contract.
  baseRewardAmount: integer, retentionDays: integer,
  interactionRewardTiers: z.array(z.object({ threshold: integer.positive(), amount: integer })),
  bodyRequired: z.boolean(), minBodyLength: integer, minImageCount: integer,
  publicRequired: z.boolean(), clickableTopicRequired: z.boolean(),
  rules: z.array(z.object({ id: z.string(), scope: z.string(), ruleType: z.string(), topic: z.string(),
    exactMatch: z.boolean(), clickableRequired: z.boolean(), caseSensitive: z.boolean(),
    minCount: integer, sortOrder: z.number().int(), version: integer,
  }).passthrough()).min(1),
}).passthrough();

/** No current Campaign lookup: an incomplete legacy contract is not repairable by guessing. */
export function readFollowUpContract(snapshot: string, binding: {
  productId: string; campaignId: string; channel: string | null;
}): AuditContext | null {
  try {
    const parsed = contractSchema.parse(JSON.parse(snapshot));
    if (parsed.productId !== binding.productId || parsed.campaignId !== binding.campaignId ||
        binding.channel !== "XIAOHONGSHU" ||
        (parsed.rewardMode === "CONTENT_BASE_PLUS_INTERACTION_TIERS" && !parsed.interactionRewardTiers.length) ||
        new Set(parsed.interactionRewardTiers.map((tier) => tier.threshold)).size !== parsed.interactionRewardTiers.length) return null;
    // A stored policy remains part of the exact original contract, including
    // explicit NOT_REQUIRED. Do not replace it with today's store policy.
    return parsed as AuditContext;
  } catch { return null; }
}

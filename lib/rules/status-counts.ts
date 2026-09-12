import type { RuleCounts } from "./types";

type StoreRuleCounts = Pick<
  RuleCounts,
  "storeTopicRules" | "storeAliases"
>;

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export async function resolveRuleCountsFromState(
  value: string | null | undefined,
  loadCurrentStoreCounts: () => Promise<StoreRuleCounts>,
): Promise<RuleCounts> {
  let parsed: Partial<RuleCounts> = {};
  try {
    const candidate = JSON.parse(value || "{}");
    if (candidate && typeof candidate === "object") {
      parsed = candidate as Partial<RuleCounts>;
    }
  } catch {
    parsed = {};
  }

  const needsStoreFallback =
    !validCount(parsed.storeTopicRules) || !validCount(parsed.storeAliases);
  const storeFallback = needsStoreFallback
    ? await loadCurrentStoreCounts()
    : null;

  return {
    products: validCount(parsed.products) ? parsed.products : 0,
    activities: validCount(parsed.activities) ? parsed.activities : 0,
    stageGroups: validCount(parsed.stageGroups) ? parsed.stageGroups : 0,
    topicRules: validCount(parsed.topicRules) ? parsed.topicRules : 0,
    storeTopicRules: validCount(parsed.storeTopicRules)
      ? parsed.storeTopicRules
      : storeFallback!.storeTopicRules,
    storeAliases: validCount(parsed.storeAliases)
      ? parsed.storeAliases
      : storeFallback!.storeAliases,
  };
}

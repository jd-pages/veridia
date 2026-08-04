import { normalizeTopic } from "@/lib/topic";

export interface CampaignStageRuleLike {
  campaignId?: string | null;
  topicCategory?: string | null;
  applicableStage?: string | null;
  topic: string;
}

export function campaignRequiresProductStage(
  rules: readonly CampaignStageRuleLike[],
) {
  const stageRules = rules.filter(
    (rule) =>
      rule.topicCategory === "PRODUCT_STAGE" &&
      Boolean(rule.applicableStage),
  );
  if (!stageRules.length) return false;

  const stageTopics = new Set(
    stageRules.map((rule) => normalizeTopic(rule.topic)).filter(Boolean),
  );
  const standardTopics = new Set(
    rules
      .filter((rule) => rule.topicCategory !== "PRODUCT_STAGE")
      .map((rule) => normalizeTopic(rule.topic))
      .filter(Boolean),
  );

  // Some campaigns retain IFFO/GUM rows only as compatibility data. When all
  // stage rows point to the same topic and that topic is already a standard
  // requirement, selecting a stage does not change the actual audit rules.
  if (
    stageTopics.size === 1 &&
    standardTopics.has([...stageTopics][0])
  ) {
    return false;
  }
  return true;
}

export function rulesRequireAnyProductStage(
  rules: readonly CampaignStageRuleLike[],
) {
  const campaignIds = [
    ...new Set(
      rules
        .filter((rule) => rule.topicCategory === "PRODUCT_STAGE")
        .map((rule) => rule.campaignId || "__NO_CAMPAIGN__"),
    ),
  ];
  return campaignIds.some((campaignId) =>
    campaignRequiresProductStage(
      rules.filter(
        (rule) => (rule.campaignId || "__NO_CAMPAIGN__") === campaignId,
      ),
    ),
  );
}

import { normalizeTopic } from "@/lib/topic";

interface TopicRuleSnapshot {
  rules?: Array<{
    ruleType?: string;
    topicCategory?: string;
    topic?: string;
    minCount?: number;
  }>;
}

function uniqueTopics(values: string[]) {
  return [...new Set(values.map(normalizeTopic).filter(Boolean))];
}

export function topicAuditRuleSummary(
  ruleSnapshot: string | undefined,
  detectedTopics: string[],
) {
  let snapshot: TopicRuleSnapshot = {};
  try {
    snapshot = JSON.parse(ruleSnapshot || "{}") as TopicRuleSnapshot;
  } catch {
    snapshot = {};
  }

  const applicableRules = (snapshot.rules || []).filter(
    (rule) =>
      Boolean(rule.topic) &&
      rule.ruleType !== "FORBIDDEN" &&
      rule.ruleType !== "ALIAS",
  );
  const requiredTopics = uniqueTopics(
    applicableRules
      .filter(
        (rule) =>
          rule.ruleType !== "ANY" &&
          rule.topicCategory !== "PRODUCT_STAGE",
      )
      .map((rule) => String(rule.topic || "")),
  );
  const anyRules = applicableRules.filter(
    (rule) =>
      rule.ruleType === "ANY" &&
      rule.topicCategory !== "PRODUCT_STAGE",
  );
  const anyCandidates = uniqueTopics(
    anyRules.map((rule) => String(rule.topic || "")),
  );
  const anyMinimum = anyCandidates.length
    ? Math.max(1, ...anyRules.map((rule) => Number(rule.minCount || 0)))
    : 0;
  const stageCandidates = uniqueTopics(
    applicableRules
      .filter((rule) => rule.topicCategory === "PRODUCT_STAGE")
      .map((rule) => String(rule.topic || "")),
  );
  const detected = new Set(uniqueTopics(detectedTopics));
  const matchedRequiredTopics = requiredTopics.filter((topic) =>
    detected.has(topic),
  );
  const missingRequiredTopics = requiredTopics.filter(
    (topic) => !detected.has(topic),
  );
  const matchedAnyCandidates = anyCandidates.filter((topic) =>
    detected.has(topic),
  );
  const unmatchedAnyCandidates = anyCandidates.filter(
    (topic) => !detected.has(topic),
  );
  const matchedStageCandidates = stageCandidates.filter((topic) =>
    detected.has(topic),
  );

  return {
    requiredTopics,
    matchedRequiredTopics,
    missingRequiredTopics,
    anyCandidates,
    anyMinimum,
    matchedAnyCandidates,
    unmatchedAnyCandidates,
    anyMissingCount: Math.max(0, anyMinimum - matchedAnyCandidates.length),
    stageCandidates,
    matchedStageCandidates,
    stageGroupMissing:
      stageCandidates.length > 0 && matchedStageCandidates.length === 0,
    expectedCount:
      requiredTopics.length + anyMinimum + (stageCandidates.length ? 1 : 0),
    matchedCount:
      matchedRequiredTopics.length +
      Math.min(matchedAnyCandidates.length, anyMinimum) +
      (matchedStageCandidates.length ? 1 : 0),
  };
}

export const CANONICAL_PRODUCT_STAGES = [
  "P段",
  "1段",
  "2段",
  "3段",
  "4段",
  "1+段",
  "2+段",
] as const;

export type CanonicalProductStage = (typeof CANONICAL_PRODUCT_STAGES)[number];

export const PRODUCT_STAGE_TOPIC_OPTIONS = [
  { value: "IFFO_P1", label: "IFFO：P段/1段" },
  { value: "IFFO_2", label: "IFFO：2段" },
  { value: "GUM_3_4_1PLUS_2PLUS", label: "GUM：3段/4段/1+段/2+段" },
] as const;

export type ProductStageTopicValue =
  (typeof PRODUCT_STAGE_TOPIC_OPTIONS)[number]["value"];
export type ProductStageGroup = ProductStageTopicValue;

export const PRODUCT_STAGE_TOPIC_VALUES = PRODUCT_STAGE_TOPIC_OPTIONS.map(
  (item) => item.value,
);

const GROUP_STAGES: Record<
  ProductStageTopicValue,
  CanonicalProductStage[]
> = {
  IFFO_P1: ["P段", "1段"],
  IFFO_2: ["2段"],
  GUM_3_4_1PLUS_2PLUS: ["3段", "4段", "1+段", "2+段"],
};

const GROUP_ALLOWED_LABELS: Record<ProductStageTopicValue, string[]> = {
  IFFO_P1: ["P段", "PRE", "PRE段", "1段"],
  IFFO_2: ["2段"],
  GUM_3_4_1PLUS_2PLUS: ["3段", "4段", "1+段", "2+段"],
};

const GROUP_LABELS = Object.fromEntries(
  PRODUCT_STAGE_TOPIC_OPTIONS.map((item) => [item.value, item.label]),
) as Record<ProductStageTopicValue, string>;

const LEGACY_GROUP_VALUES: Record<string, ProductStageTopicValue> = {
  IFFO_NEWBORN: "IFFO_P1",
  IFFO_STAGE_2: "IFFO_2",
  GUM: "GUM_3_4_1PLUS_2PLUS",
};

const TOKEN_PATTERN =
  /(?<![A-Z0-9+])(?:1\s*\+\s*段|2\s*\+\s*段|PRE\s*段|PRE|P\s*段|4\s*段|3\s*段|2\s*段|1\s*段)(?![A-Z0-9+])/giu;

const TOKEN_PRIORITY = [
  "1+段",
  "2+段",
  "PRE段",
  "PRE",
  "P段",
  "4段",
  "3段",
  "2段",
  "1段",
];

export interface ProductStageDetection {
  status: "MATCHED" | "MISSING" | "CONFLICT";
  matchedStages: CanonicalProductStage[];
  matchedTokens: string[];
  matchedGroups: ProductStageTopicValue[];
  group: ProductStageTopicValue | null;
  groupLabel: string | null;
  preferredStage: CanonicalProductStage | null;
}

export interface BodyProductStageEvaluation {
  status: "MATCHED" | "MISSING" | "OUTSIDE_GROUP";
  group: ProductStageTopicValue;
  groupLabel: string;
  allowedStages: string[];
  detectedStages: string[];
  matchedAllowedStages: string[];
  passed: boolean;
}

function normalizeCharacters(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[＋﹢]/gu, "+")
    .toUpperCase();
}

function normalizeMatchedToken(value: string): string | null {
  const normalized = normalizeCharacters(value).replace(/\s+/gu, "");
  if (normalized === "PRE段") return "PRE段";
  if (normalized === "PRE") return "PRE";
  if (normalized === "P段") return "P段";
  if (/^[12]\+段$/u.test(normalized)) return normalized;
  if (/^[1-4]段$/u.test(normalized)) return normalized;
  return null;
}

function tokenToCanonicalStage(token: string): CanonicalProductStage | null {
  if (token === "PRE" || token === "PRE段" || token === "P段") return "P段";
  return normalizeProductStage(token);
}

export function normalizeProductStage(
  value: string,
): CanonicalProductStage | null {
  const normalized = normalizeCharacters(value).replace(/\s+/gu, "");
  if (/^(?:P|PRE)(?:段)?$/u.test(normalized)) return "P段";
  if (/^[12]\+(?:段)?$/u.test(normalized)) {
    return `${normalized.slice(0, 2)}段` as CanonicalProductStage;
  }
  if (/^[1-4](?:段)?$/u.test(normalized)) {
    return `${normalized[0]}段` as CanonicalProductStage;
  }
  return null;
}

export function productStageGroup(
  stage: CanonicalProductStage,
): ProductStageTopicValue {
  if (stage === "P段" || stage === "1段") return "IFFO_P1";
  if (stage === "2段") return "IFFO_2";
  return "GUM_3_4_1PLUS_2PLUS";
}

export function normalizeProductStageTopicValue(
  value: string | null | undefined,
): ProductStageTopicValue | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (PRODUCT_STAGE_TOPIC_VALUES.includes(raw as ProductStageTopicValue)) {
    return raw as ProductStageTopicValue;
  }
  if (LEGACY_GROUP_VALUES[raw]) return LEGACY_GROUP_VALUES[raw];

  const compact = normalizeCharacters(raw)
    .replace(/\s+/gu, "")
    .replace(/：/gu, ":");
  const direct = PRODUCT_STAGE_TOPIC_OPTIONS.find(
    (item) =>
      normalizeCharacters(item.label)
        .replace(/\s+/gu, "")
        .replace(/：/gu, ":") === compact,
  );
  if (direct) return direct.value;

  const detection = detectProductStage([raw]);
  return detection.status === "MATCHED" ? detection.group : null;
}

export function productStageTopicLabel(
  value: string | null | undefined,
): string {
  const normalized = normalizeProductStageTopicValue(value);
  return normalized ? GROUP_LABELS[normalized] : value || "段位未识别";
}

export function allowedBodyStageLabels(
  value: string | null | undefined,
): string[] {
  const normalized = normalizeProductStageTopicValue(value);
  return normalized ? [...GROUP_ALLOWED_LABELS[normalized]] : [];
}

export function stageTopicFromRuleSnapshot(
  ruleSnapshot: string | null | undefined,
): string | null {
  if (!ruleSnapshot) return null;
  try {
    const snapshot = JSON.parse(ruleSnapshot) as {
      rules?: Array<{ topic?: string; topicCategory?: string }>;
    };
    return (
      snapshot.rules?.find(
        (rule) =>
          rule.topicCategory === "PRODUCT_STAGE" && Boolean(rule.topic),
      )?.topic || null
    );
  } catch {
    return null;
  }
}

export function bodyStageRequiredFromRuleSnapshot(
  ruleSnapshot: string | null | undefined,
): boolean {
  if (!ruleSnapshot) return false;
  try {
    const snapshot = JSON.parse(ruleSnapshot) as {
      bodyStageRequired?: boolean;
    };
    return snapshot.bodyStageRequired === true;
  } catch {
    return false;
  }
}

export function compatibleStageRuleValues(
  value: string | null | undefined,
): string[] {
  const normalized = normalizeProductStageTopicValue(value);
  if (!normalized) return [];
  return [normalized, ...GROUP_STAGES[normalized]];
}

export function detectProductStage(
  values: Array<string | null | undefined>,
): ProductStageDetection {
  const source = normalizeCharacters(values.filter(Boolean).join(" | "));
  const matchedTokens = [
    ...new Set(
      (source.match(TOKEN_PATTERN) || [])
        .map(normalizeMatchedToken)
        .filter((token): token is string => Boolean(token)),
    ),
  ].sort(
    (left, right) =>
      TOKEN_PRIORITY.indexOf(left) - TOKEN_PRIORITY.indexOf(right),
  );
  const matchedStages = [
    ...new Set(
      matchedTokens
        .map(tokenToCanonicalStage)
        .filter((stage): stage is CanonicalProductStage => Boolean(stage)),
    ),
  ];
  const matchedGroups = [
    ...new Set(matchedStages.map((stage) => productStageGroup(stage))),
  ];

  if (!matchedStages.length) {
    return {
      status: "MISSING",
      matchedStages: [],
      matchedTokens: [],
      matchedGroups: [],
      group: null,
      groupLabel: null,
      preferredStage: null,
    };
  }
  if (matchedGroups.length > 1) {
    return {
      status: "CONFLICT",
      matchedStages,
      matchedTokens,
      matchedGroups,
      group: null,
      groupLabel: null,
      preferredStage: null,
    };
  }

  const group = matchedGroups[0];
  return {
    status: "MATCHED",
    matchedStages,
    matchedTokens,
    matchedGroups,
    group,
    groupLabel: GROUP_LABELS[group],
    preferredStage: matchedStages[0],
  };
}

export function detectBodyProductStages(
  body: string | null | undefined,
  configuredGroup: string | null | undefined,
  override?: {
    label?: string | null;
    canonicalStages?: string[];
    bodyTerms?: string[];
  },
): BodyProductStageEvaluation | null {
  const group = normalizeProductStageTopicValue(configuredGroup);
  if (!group) return null;
  const bodyWithoutTopics = String(body || "")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/#[^\s#]+/gu, " ");
  const detection = detectProductStage([bodyWithoutTopics]);
  const allowedCanonical = new Set(
    (override?.canonicalStages || GROUP_STAGES[group])
      .map(normalizeProductStage)
      .filter((value): value is CanonicalProductStage => Boolean(value)),
  );
  const matchedAllowedStages = detection.matchedTokens.filter((token) => {
    const stage = tokenToCanonicalStage(token);
    return Boolean(stage && allowedCanonical.has(stage));
  });
  const passed = matchedAllowedStages.length > 0;
  return {
    status: passed
      ? "MATCHED"
      : detection.matchedTokens.length
        ? "OUTSIDE_GROUP"
        : "MISSING",
    group,
    groupLabel: override?.label || GROUP_LABELS[group],
    allowedStages: override?.bodyTerms?.length
      ? [...override.bodyTerms]
      : [...GROUP_ALLOWED_LABELS[group]],
    detectedStages: detection.matchedTokens,
    matchedAllowedStages,
    passed,
  };
}

export function resolveConfiguredProductStage(
  detection: ProductStageDetection,
  configuredStages: Array<string | null | undefined>,
): ProductStageTopicValue | null {
  if (detection.status !== "MATCHED" || !detection.group) return null;
  const configuredGroups = new Set(
    configuredStages
      .map(normalizeProductStageTopicValue)
      .filter((value): value is ProductStageTopicValue => Boolean(value)),
  );
  return configuredGroups.has(detection.group) ? detection.group : null;
}

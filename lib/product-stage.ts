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
  { value: "IFFO", label: "IFFO" },
  { value: "GUM", label: "GUM" },
] as const;

export type ProductStageTopicValue =
  (typeof PRODUCT_STAGE_TOPIC_OPTIONS)[number]["value"];
export type ProductStageGroup = ProductStageTopicValue;

export const DETAILED_PRODUCT_STAGE_OPTIONS = [
  {
    value: "IFFO_P1",
    label: "IFFO 新生儿组（P段/1段）",
    phase: "IFFO",
    stages: ["P段", "1段"],
  },
  {
    value: "IFFO_2",
    label: "IFFO 二段组（2段）",
    phase: "IFFO",
    stages: ["2段"],
  },
  {
    value: "GUM_3_4_1PLUS_2PLUS",
    label: "GUM 成长组（3段/4段/1+段/2+段）",
    phase: "GUM",
    stages: ["3段", "4段", "1+段", "2+段"],
  },
] as const;

export type DetailedProductStageValue =
  (typeof DETAILED_PRODUCT_STAGE_OPTIONS)[number]["value"];

const DETAILED_STAGE_BY_VALUE = Object.fromEntries(
  DETAILED_PRODUCT_STAGE_OPTIONS.map((item) => [item.value, item]),
) as Record<DetailedProductStageValue, (typeof DETAILED_PRODUCT_STAGE_OPTIONS)[number]>;

export const PRODUCT_STAGE_TOPIC_VALUES = PRODUCT_STAGE_TOPIC_OPTIONS.map(
  (item) => item.value,
);

const GROUP_STAGES: Record<
  ProductStageTopicValue,
  CanonicalProductStage[]
> = {
  IFFO: ["P段", "1段", "2段"],
  GUM: ["3段", "4段", "1+段", "2+段"],
};

const GROUP_ALLOWED_LABELS: Record<ProductStageTopicValue, string[]> = {
  IFFO: ["P段", "PRE", "PRE段", "1段", "2段"],
  GUM: ["3段", "4段", "1+段", "2+段"],
};

const GROUP_LABELS = Object.fromEntries(
  PRODUCT_STAGE_TOPIC_OPTIONS.map((item) => [item.value, item.label]),
) as Record<ProductStageTopicValue, string>;

const LEGACY_GROUP_VALUES: Record<string, ProductStageTopicValue> = {
  IFFO_P1: "IFFO",
  IFFO_2: "IFFO",
  IFFO_NEWBORN: "IFFO",
  IFFO_STAGE_2: "IFFO",
  GUM_3_4_1PLUS_2PLUS: "GUM",
};

const LEGACY_GROUP_LABELS: Record<string, ProductStageTopicValue> = {
  "IFFO:P段/1段": "IFFO",
  "IFFO:2段": "IFFO",
  "GUM:3段/4段/1+段/2+段": "GUM",
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

export interface StageTopicDisplaySource {
  key: string;
  requiredTopic: string;
  ruleSource?: string | null;
}

export interface ProductStageTopicDisplayRow<
  T extends StageTopicDisplaySource = StageTopicDisplaySource,
> {
  key: ProductStageTopicValue;
  requiredTopics: string[];
  ruleSources: string[];
  members: T[];
}

export interface DetailedProductStageTopicDisplayRow<
  T extends StageTopicDisplaySource = StageTopicDisplaySource,
> {
  key: DetailedProductStageValue;
  label: string;
  requiredTopics: string[];
  ruleSources: string[];
  members: T[];
}

export interface ProductStageTopicRuleSource {
  topic: string;
  topicCategory?: string | null;
  applicableStage?: string | null;
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
  if (stage === "P段" || stage === "1段" || stage === "2段") return "IFFO";
  return "GUM";
}

function normalizedGroupInput(value: string | null | undefined) {
  return normalizeCharacters(String(value || "").trim())
    .replace(/\s+/gu, "")
    .replace(/：/gu, ":");
}

export function normalizeDetailedProductStageValue(
  value: string | null | undefined,
): DetailedProductStageValue | null {
  const compact = normalizedGroupInput(value);
  if (!compact) return null;
  if (compact in DETAILED_STAGE_BY_VALUE) {
    return compact as DetailedProductStageValue;
  }
  const normalizedStage = normalizeProductStage(compact);
  if (!normalizedStage) return null;
  return DETAILED_PRODUCT_STAGE_OPTIONS.find((item) =>
    (item.stages as readonly string[]).includes(normalizedStage),
  )?.value || null;
}

export function detailedProductStagePhase(
  value: string | null | undefined,
): ProductStageTopicValue | null {
  const detailed = normalizeDetailedProductStageValue(value);
  return detailed ? DETAILED_STAGE_BY_VALUE[detailed].phase : null;
}

export function detailedProductStageLabel(
  value: string | null | undefined,
): string {
  const detailed = normalizeDetailedProductStageValue(value);
  return detailed ? DETAILED_STAGE_BY_VALUE[detailed].label : productStageTopicLabel(value);
}

export function campaignUsesDetailedProductStages(
  brandName: string | null | undefined,
  month: string | null | undefined,
): boolean {
  return brandName?.trim() === "达能" && Boolean(month && month >= "2026-08");
}

export function normalizeConfiguredProductStageValue(
  value: string | null | undefined,
  detailed: boolean,
): string | null {
  return detailed
    ? normalizeDetailedProductStageValue(value)
    : normalizeProductStageTopicValue(value);
}

export function normalizeImportedProductStageTopicValue(
  value: string | null | undefined,
): ProductStageTopicValue | null {
  const compact = normalizedGroupInput(value);
  if (!compact) return null;
  if (compact === "IFFO" || compact === "GUM") {
    return compact as ProductStageTopicValue;
  }
  if (LEGACY_GROUP_VALUES[compact]) return LEGACY_GROUP_VALUES[compact];
  return LEGACY_GROUP_LABELS[compact] || null;
}

export function normalizeProductStageTopicValue(
  value: string | null | undefined,
): ProductStageTopicValue | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const direct = normalizeImportedProductStageTopicValue(raw);
  if (direct) return direct;

  // 历史任务可能保存了具体段位，读取时继续兼容；新导入使用上面的严格入口。
  const detection = detectProductStage([raw]);
  return detection.status === "MATCHED" ? detection.group : null;
}

export function productStageTopicLabel(
  value: string | null | undefined,
): string {
  const detailed = normalizeDetailedProductStageValue(value);
  if (detailed) return DETAILED_STAGE_BY_VALUE[detailed].label;
  const normalized = normalizeProductStageTopicValue(value);
  return normalized ? GROUP_LABELS[normalized] : value || "段位未识别";
}

export function aggregateDetailedProductStageTopicRows<
  T extends StageTopicDisplaySource,
>(rows: T[]): DetailedProductStageTopicDisplayRow<T>[] {
  return DETAILED_PRODUCT_STAGE_OPTIONS.flatMap((option) => {
    const members = rows.filter(
      (row) => normalizeDetailedProductStageValue(row.key) === option.value,
    );
    if (!members.length) return [];
    return [{
      key: option.value,
      label: option.label,
      requiredTopics: [...new Set(members.map((member) => member.requiredTopic.trim()).filter(Boolean))],
      ruleSources: [...new Set(members.map((member) => member.ruleSource || "").filter(Boolean))],
      members,
    }];
  });
}

export function aggregateProductStageTopicRows<
  T extends StageTopicDisplaySource,
>(rows: T[]): ProductStageTopicDisplayRow<T>[] {
  const grouped = new Map<ProductStageTopicValue, T[]>();
  for (const row of rows) {
    const key = normalizeProductStageTopicValue(row.key);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }

  return PRODUCT_STAGE_TOPIC_OPTIONS.flatMap(({ value }) => {
    const members = grouped.get(value);
    if (!members?.length) return [];
    return [{
      key: value,
      requiredTopics: [
        ...new Set(
          members.map((member) => member.requiredTopic.trim()).filter(Boolean),
        ),
      ],
      ruleSources: [
        ...new Set(
          members.map((member) => member.ruleSource || "").filter(Boolean),
        ),
      ],
      members,
    }];
  });
}

export function stageTopicsForProductStage(
  rules: ProductStageTopicRuleSource[],
  productStage: string | null | undefined,
): string[] {
  const compatibleStages = new Set(compatibleStageRuleValues(productStage));
  return [
    ...new Set(
      rules
        .filter(
          (rule) =>
            rule.topicCategory === "PRODUCT_STAGE" &&
            compatibleStages.has(rule.applicableStage || ""),
        )
        .map((rule) => rule.topic.trim())
        .filter(Boolean),
    ),
  ];
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
  return stageTopicsFromRuleSnapshot(ruleSnapshot)[0] || null;
}

export function stageTopicsFromRuleSnapshot(
  ruleSnapshot: string | null | undefined,
): string[] {
  if (!ruleSnapshot) return [];
  try {
    const snapshot = JSON.parse(ruleSnapshot) as {
      rules?: Array<{ topic?: string; topicCategory?: string }>;
    };
    return [
      ...new Set(
        (snapshot.rules || [])
          .filter(
            (rule) =>
              rule.topicCategory === "PRODUCT_STAGE" && Boolean(rule.topic),
          )
          .map((rule) => String(rule.topic)),
      ),
    ];
  } catch {
    return [];
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
  const detailed = normalizeDetailedProductStageValue(value);
  if (detailed) {
    return [detailed, ...DETAILED_STAGE_BY_VALUE[detailed].stages];
  }
  const normalized = normalizeProductStageTopicValue(value);
  if (!normalized) return [];
  return normalized === "IFFO"
    ? [
        "IFFO",
        "IFFO_P1",
        "IFFO_2",
        "IFFO_NEWBORN",
        "IFFO_STAGE_2",
        ...GROUP_STAGES.IFFO,
      ]
    : ["GUM", "GUM_3_4_1PLUS_2PLUS", ...GROUP_STAGES.GUM];
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

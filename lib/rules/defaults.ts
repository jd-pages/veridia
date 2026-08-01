import type { RulePackageStageGroup } from "./types";

export const DEFAULT_RULE_STAGE_GROUPS: RulePackageStageGroup[] = [
  {
    key: "IFFO_P1",
    label: "IFFO：P段/1段",
    canonicalStages: ["P段", "1段"],
    bodyTerms: ["P段", "PRE", "PRE段", "1段"],
    requireBodyStage: false,
    requiredTopic: "#新生儿奶粉",
    sortOrder: 10,
    status: "ACTIVE",
  },
  {
    key: "IFFO_2",
    label: "IFFO：2段",
    canonicalStages: ["2段"],
    bodyTerms: ["2段"],
    requireBodyStage: false,
    requiredTopic: "#二段奶粉推荐",
    sortOrder: 20,
    status: "ACTIVE",
  },
  {
    key: "GUM_3_4_1PLUS_2PLUS",
    label: "GUM：3段/4段/1+段/2+段",
    canonicalStages: ["3段", "4段", "1+段", "2+段"],
    bodyTerms: ["3段", "4段", "1+段", "2+段"],
    requireBodyStage: false,
    requiredTopic: "#三段奶粉推荐",
    sortOrder: 30,
    status: "ACTIVE",
  },
];

export const DEFAULT_PAGE_STATUS_RULES = {
  normalStatuses: ["NORMAL"],
  technicalFailureStatuses: [
    "READ_FAILED",
    "LOGIN_EXPIRED",
    "SECURITY_VERIFICATION",
    "NOT_FOUND",
    "DELETED",
    "NO_PERMISSION",
  ],
};

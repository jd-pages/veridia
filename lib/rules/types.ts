import type { ImportExportTemplates } from "@/lib/import-export-templates/types";

export const RULE_PACKAGE_SCHEMA_VERSION = 1;

export interface RulePackageProduct {
  key: string;
  code: string | null;
  name: string;
  brand: string;
  series: string | null;
  category: string | null;
  aliases: string[];
  contentDirection: string | null;
  status: string;
}

export interface RulePackageCampaign {
  key: string;
  contentChannel: "XIAOHONGSHU" | "DOUYIN";
  name: string;
  month: string;
  year: number | null;
  startDate: string;
  endDate: string;
  productKeys: string[];
  minImageCount: number;
  productImageRequired?: boolean;
  firstImageRequirement?: string | null;
  prohibitedImageGuidance?: string | null;
  bodyRequired: boolean;
  minBodyLength: number;
  publicRequired: boolean;
  retentionDays: number;
  rewardDescription: string | null;
  visualReviewGuidance?: string | null;
  customerRegistrationNotes: string | null;
  clickableTopicRequired: boolean;
  ruleRevision: number;
  status: string;
}

export interface RulePackageStageGroup {
  key: string;
  label: string;
  canonicalStages: string[];
  bodyTerms: string[];
  requireBodyStage: boolean;
  requiredTopic: string;
  sortOrder: number;
  status: string;
}

export interface RulePackageTopicRule {
  key: string;
  contentChannel: "XIAOHONGSHU" | "DOUYIN" | "ALL";
  brand?: string | null;
  campaignKey: string | null;
  productKey: string | null;
  scope: string;
  ruleType: string;
  topicCategory: string;
  applicableStage: string | null;
  milkType: string | null;
  topic: string;
  exactMatch: boolean;
  clickableRequired: boolean;
  caseSensitive: boolean;
  minCount: number;
  sortOrder: number;
  revision: number;
  status: string;
  notes?: string | null;
}

export interface RulePackagePayload {
  ruleVersion: string;
  schemaVersion: number;
  publishedAt: string;
  minimumAppVersion: string;
  products: RulePackageProduct[];
  campaigns: RulePackageCampaign[];
  stageGroups: RulePackageStageGroup[];
  topicRules: RulePackageTopicRule[];
  pageStatusRules: {
    normalStatuses: string[];
    technicalFailureStatuses: string[];
  };
  importExportTemplates?: ImportExportTemplates;
}

export interface RulePackageManifest {
  ruleVersion: string;
  schemaVersion: number;
  publishedAt: string;
  minimumAppVersion: string;
  downloadUrl: string;
  fileSize: number;
  sha256: string;
  productCount: number;
  activityCount: number;
  stageGroupCount: number;
  topicRuleCount: number;
  templateVersion?: string;
  templateConfigSha256?: string;
}

export type RuleSyncStatus =
  | "UP_TO_DATE"
  | "UPDATE_AVAILABLE"
  | "DOWNLOADING"
  | "VERIFYING"
  | "APPLYING"
  | "COMPLETED"
  | "FAILED"
  | "USING_BUILTIN"
  | "RESTORED";

export interface RuleCounts {
  products: number;
  activities: number;
  stageGroups: number;
  topicRules: number;
}

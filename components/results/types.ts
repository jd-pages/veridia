import type { Key } from "react";

export interface ProductOption {
  id: string;
  name: string;
}

export interface CampaignOption {
  id: string;
  name: string;
  month: string;
  productId?: string | null;
}

export interface ImportBatchOption {
  id: string;
  fileName: string;
  createdAt: string;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  skippedCount: number;
  createdBy: string | null;
  creatorDisplayName: string | null;
  resultCount: number;
  taskCount: number;
  batchCount: number;
  label: string;
  searchText: string;
}

export interface AuditTopic {
  id: string;
  displayText: string;
  isLinkElement: boolean;
  hasHref: boolean;
  href: string | null;
  styleFeature: boolean;
  isClickable: boolean;
}

export interface ResultRow {
  id: string;
  ruleVersion: number;
  ruleSnapshot: string;
  pageStatus: string;
  bodyStatus: string;
  effectiveBodyLength: number;
  bodyCompliant: boolean;
  noteType: string;
  imageExtractionStatus: string;
  imageStatus: string;
  imageCount: number | null;
  imageCompliant: boolean | null;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  storeTopicStatus: string;
  expectedStoreTopic: string | null;
  expectedStoreTopics: string;
  requiredStoreTopics: string;
  matchedStoreTopic: string | null;
  matchedStoreTopics: string;
  matchedRequiredStoreTopics: string;
  storeTopicFailureReason: string | null;
  missingTopics: string;
  forbiddenTopics: string;
  autoStatus: string;
  publicStatus: string;
  retentionStatus: string;
  retentionDueAt: string | null;
  failureReasons: string;
  auditedAt: string;
  note: {
    url: string;
    finalUrl: string | null;
    platformNoteId: string | null;
    title: string | null;
    body: string | null;
    publishedAt: string | null;
    publishedAtRaw: string | null;
    publishedAtSource: string | null;
    lastCapturedAt: string;
    topics: AuditTopic[];
  };
  task: {
    importRecordId: string | null;
    productStage: string | null;
    url: string;
    finalUrl: string | null;
    source: string;
    status: string;
    attempts: number;
    failureCode: string | null;
    failureMessage: string | null;
    failureEvidence?: string | null;
    platform: string | null;
    channel: string | null;
    commercePlatform: string | null;
    storeName: string | null;
    storeTopicRuleId: string | null;
    matchedStoreName: string | null;
    expectedStoreTopic: string | null;
    expectedStoreTopics: string;
    requiredStoreTopics: string;
    storeMappingStatus: string | null;
    orderNumber: string | null;
    product: ProductOption;
    campaign: CampaignOption;
    importRecord: {
      id: string;
      fileName: string;
      createdAt: string;
    } | null;
  };
  manualReviews: Array<{
    id?: string;
    result: string;
    comment: string | null;
    createdAt?: string;
    reviewer?: { displayName: string };
  }>;
}

export interface ResultPageData {
  total: number;
  page: number;
  pageSize: number;
  items: ResultRow[];
}

export interface ResultFilters {
  importRecordId: string;
  productId: string;
  campaignId: string;
  commercePlatform: string;
  channel: string;
  orderNumber: string;
  startDate: string;
  endDate: string;
  dateType: "AUDITED_AT" | "CREATED_AT";
  status: string;
  imageStatus: string;
  keyword: string;
  reason: string;
  manualStatus: string;
  riskType: string;
}

export interface AdvancedResultFilters {
  pageStatus: string;
  bodyStatus: string;
  topicsStatus: string;
  noteType: string;
  publicStatus: string;
}

export interface ResultSummary {
  total: number;
  passed: number;
  failed: number;
  notFound: number;
  review: number;
}

export interface ResultDetail extends ResultRow {
  note: ResultRow["note"] & {
    authorName: string | null;
    isPublic: boolean | null;
    extractions: Array<{
      id: string;
      rawData: string;
      extractedAt: string;
      adapterVersion: string;
    }>;
  };
  ruleResults: Array<{
    id: string;
    ruleKey: string;
    ruleName: string;
    expectedValue: string;
    actualValue: string;
    passed: boolean;
    failureReason: string | null;
    evidence: string;
  }>;
  operationLogs: Array<{
    id: string;
    summary: string;
    createdAt: string;
    user: { displayName: string } | null;
  }>;
}

export type BulkAction =
  | "RE_AUDIT"
  | "MANUAL_PASS"
  | "MANUAL_FAIL";

export type SelectedKeys = Key[];

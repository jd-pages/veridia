export type PageStatus =
  | "NORMAL"
  | "NOT_FOUND"
  | "DELETED"
  | "NO_PERMISSION"
  | "LOGIN_EXPIRED"
  | "SECURITY_VERIFICATION"
  | "READ_FAILED"
  | "NEEDS_CONFIRMATION";

export type AuditStatus = "PASSED" | "FAILED" | "NEEDS_REVIEW" | "READ_FAILED";
export type NoteType = "IMAGE_TEXT" | "VIDEO_NOTE" | "UNKNOWN";
export type ImageExtractionStatus =
  | "SUCCESS"
  | "VIDEO_NOTE"
  | "IMAGES_READ_FAILED"
  | "NOT_CHECKED";
export type ImageAuditStatus =
  | "COMPLIANT"
  | "NON_COMPLIANT"
  | "VIDEO_NOTE"
  | "IMAGES_READ_FAILED"
  | "NOT_REQUIRED";

export interface ExtractedTopic {
  displayText: string;
  isLinkElement: boolean;
  hasHref: boolean;
  href?: string | null;
  textColor?: string | null;
  styleFeature: boolean;
  domPath?: string | null;
}

export interface ExtractedNote {
  url: string;
  finalUrl?: string | null;
  pageTitle?: string | null;
  pageType?: string | null;
  redirectChain?: string[];
  noteId?: string | null;
  title?: string | null;
  body?: string | null;
  noteType?: NoteType;
  imageExtractionStatus?: ImageExtractionStatus;
  imageCount?: number;
  // 仅兼容旧提取负载；服务端会在持久化前移除 URL。
  imageUrls?: string[];
  topics: ExtractedTopic[];
  pageStatus: PageStatus;
  authorName?: string | null;
  publishedAt?: string | null;
  isPublic?: boolean | null;
  extractedAt: string;
  adapterName: string;
  adapterVersion: string;
}

export interface AuditRule {
  id: string;
  scope: string;
  ruleType: string;
  topic: string;
  exactMatch: boolean;
  clickableRequired: boolean;
  caseSensitive: boolean;
  minCount: number;
  sortOrder: number;
  version: number;
  topicCategory?: string;
  applicableStage?: string | null;
  milkType?: string | null;
}

export interface AuditContext {
  productId: string;
  campaignId: string;
  campaignName: string;
  productStage?: string | null;
  milkType?: string | null;
  ruleVersion: number;
  bodyRequired: boolean;
  minBodyLength: number;
  minImageCount: number;
  publicRequired: boolean;
  retentionDays: number;
  customerRegistrationNotes?: string | null;
  clickableTopicRequired: boolean;
  rules: AuditRule[];
}

export interface RuleEvaluation {
  ruleKey: string;
  ruleName: string;
  expectedValue: string;
  actualValue: string;
  passed: boolean;
  failureReason?: string;
  evidence: Record<string, unknown>;
}

export interface AuditEvaluation {
  pageStatus: PageStatus;
  bodyStatus: "PRESENT" | "EMPTY";
  effectiveBodyLength: number;
  bodyCompliant: boolean;
  noteType: NoteType;
  imageExtractionStatus: ImageExtractionStatus;
  imageStatus: ImageAuditStatus;
  imageCount: number | null;
  imageCompliant: boolean | null;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  publicStatus: "NOT_REQUIRED" | "PUBLIC" | "NOT_PUBLIC" | "UNKNOWN";
  retentionStatus:
    | "NOT_REQUIRED"
    | "PENDING"
    | "SATISFIED"
    | "NOT_SATISFIED";
  retentionDueAt?: string | null;
  missingTopics: string[];
  forbiddenTopics: string[];
  autoStatus: AuditStatus;
  failureReasons: string[];
  ruleResults: RuleEvaluation[];
}

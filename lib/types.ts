export type PageStatus =
  | "NORMAL"
  | "NOTE_NOT_FOUND"
  | "NO_PERMISSION"
  | "LOGIN_EXPIRED"
  | "SECURITY_VERIFICATION"
  | "READ_FAILED"
  | "NEEDS_CONFIRMATION";

export type AuditStatus =
  | "PASSED"
  | "FAILED"
  | "NOTE_NOT_FOUND"
  | "NEEDS_REVIEW"
  | "READ_FAILED";
export type NoteType = "IMAGE_TEXT" | "VIDEO" | "VIDEO_NOTE" | "UNKNOWN";
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
export type InteractionExtractionStatus =
  | "SUCCESS"
  | "UNAVAILABLE"
  | "NOT_CHECKED";

export interface ExtractedTopic {
  displayText: string;
  isClickable?: boolean;
  isLinkElement: boolean;
  hasHref: boolean;
  href?: string | null;
  textColor?: string | null;
  styleFeature: boolean;
  domPath?: string | null;
  source?: string | null;
  contentId?: string | null;
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
  likeCount?: number | null;
  favoriteCount?: number | null;
  commentCount?: number | null;
  interactionExtractionStatus?: InteractionExtractionStatus;
  interactionTechnicalMessage?: string | null;
  // 仅兼容旧提取负载；服务端会在持久化前移除 URL。
  imageUrls?: string[];
  topics: ExtractedTopic[];
  /** XHS visible-body hashtag strings. Diagnostic only; never audit evidence. */
  textHashtagCandidates?: ExtractedTopic[];
  /** XHS topics verified by current-note structured data or scoped clickable DOM. */
  verifiedPlatformTopics?: ExtractedTopic[];
  /** The XHS topic region was read successfully, even when it contains no topics. */
  topicEvidenceCollected?: boolean;
  pageStatus: PageStatus;
  authorName?: string | null;
  publishedAt?: string | null;
  publishedAtRaw?: string | null;
  publishedAtSource?: string | null;
  isPublic?: boolean | null;
  extractedAt: string;
  adapterName: string;
  adapterVersion: string;
  technicalWarnings?: string[];
  pageEvidence?: Record<string, unknown>;
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
  contentChannel?: "XIAOHONGSHU" | "DOUYIN";
  rulesConfigured?: boolean;
  ruleMonth?: string;
  brandName?: string;
  basicRewardRequired?: boolean;
  requiresProductStage?: boolean;
  productStage?: string | null;
  productStageLabel?: string | null;
  bodyStageRequired?: boolean;
  allowedBodyStageTerms?: string[];
  canonicalBodyStages?: string[];
  milkType?: string | null;
  ruleVersion: number;
  rulePackageVersion?: string | null;
  bodyRequired: boolean;
  minBodyLength: number;
  minImageCount: number;
  publicRequired: boolean;
  retentionDays: number;
  customerRegistrationNotes?: string | null;
  clickableTopicRequired: boolean;
  rules: AuditRule[];
  storeTopicRequirement?: {
    channel: "XIAOHONGSHU" | "DOUYIN" | null;
    storeName: string | null;
    storeTopicRuleId: string | null;
    matchedStoreName: string | null;
    commercePlatform: "JD" | "DOUYIN_ECOMMERCE" | "TMALL" | "TAOBAO" | null;
    expectedTopic: string | null;
    expectedTopics: string[];
    requiredTopics: string[];
    mappingStatus: "MATCHED" | "STORE_NAME_MISSING" | "STORE_NOT_MAPPED";
  } | null;
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
  bodyStatus: "PRESENT" | "EMPTY" | "UNKNOWN";
  effectiveBodyLength: number;
  bodyCompliant: boolean;
  noteType: NoteType;
  imageExtractionStatus: ImageExtractionStatus;
  imageStatus: ImageAuditStatus;
  imageCount: number | null;
  imageCompliant: boolean | null;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  storeTopicStatus:
    | "NOT_REQUIRED"
    | "NOT_CHECKED"
    | "COMPLIANT"
    | "NON_COMPLIANT"
    | "UNREVIEWABLE";
  expectedStoreTopic: string | null;
  expectedStoreTopics: string[];
  requiredStoreTopics: string[];
  matchedStoreTopic: string | null;
  matchedStoreTopics: string[];
  matchedRequiredStoreTopics: string[];
  storeTopicFailureReason: string | null;
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

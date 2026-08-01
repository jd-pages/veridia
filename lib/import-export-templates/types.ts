export const TEMPLATE_SCHEMA_VERSION = 1;

export const LOCAL_TABULAR_SOURCE_TYPES = [
  "EXCEL_XLSX",
  "EXCEL_XLS",
  "CSV",
  "TENCENT_DOCS_EXPORTED_XLSX",
  "TENCENT_DOCS_EXPORTED_CSV",
] as const;

export type LocalTabularSourceType =
  (typeof LOCAL_TABULAR_SOURCE_TYPES)[number];
export type TabularSourceType =
  | LocalTabularSourceType
  | "TENCENT_DOCS_ONLINE_LINK";

export type StandardField =
  | "noteUrl"
  | "noteId"
  | "productName"
  | "activityName"
  | "influencerName"
  | "publishTime"
  | "title"
  | "content"
  | "imageCount"
  | "topicTags"
  | "screenshotStatus"
  | "noteStatus"
  | "auditStatus"
  | "auditResult"
  | "failedReasons"
  | "matchedRules"
  | "ruleVersion"
  | "reviewedBy"
  | "reviewedAt"
  | "remark"
  | "productCode"
  | "activityMonth"
  | "contentChannel"
  | "specification"
  | "productStage"
  | "source"
  | "productStageTopic"
  | "allowedBodyStages"
  | "detectedBodyStages"
  | "requiredStageTopic"
  | "imageExtractionStatus"
  | "imageStatus"
  | "originalUrl"
  | "finalUrl"
  | "exceptionCategory"
  | "failureReason"
  | "needsManualReview"
  | "manualReviewStatus"
  | "attemptCount"
  | "auditCreatedAt"
  | "auditCompletedAt"
  | "taskCreatedAt"
  | "dateFilterBasis"
  | "pageStatus"
  | "bodyStatus"
  | "topicsAuditResult"
  | "autoAuditResult"
  | "manualAuditResult"
  | "finalAuditConclusion"
  | "manualReviewComment"
  | "auditTime";

export interface ImportExportTemplates {
  schemaVersion: number;
  templateVersion: string;
  importTemplates: Record<string, {
    sheetName: string;
    headerRowSearchLimit: number;
    previewRowLimit: number;
    unknownFieldPolicy: "IGNORE" | "PRESERVE";
  }>;
  exportTemplates: Record<string, {
    sheetName: string;
    multiValueSeparator: string;
  }>;
  fieldDefinitions: Record<string, {
    displayName: string;
    type: "string" | "url" | "integer" | "datetime" | "stringList";
    description: string;
  }>;
  fieldAliases: Record<string, string[]>;
  requiredFields: StandardField[];
  optionalFields: StandardField[];
  columnOrder: {
    import: StandardField[];
    auditResults: StandardField[];
    auditTasks: StandardField[];
  };
  dataValidation: {
    maxFileBytes: number;
    maxRows: number;
    skipBlankRows: boolean;
    trimWhitespace: boolean;
    caseInsensitiveHeaders: boolean;
  };
  examples: Record<string, string>;
  compatibility: {
    minimumAppVersion: string;
    supportedTemplateSchemaVersions: number[];
  };
  sourcePresets: Partial<Record<LocalTabularSourceType, {
    extensions: string[];
    localOnly: true;
  }>>;
}

export interface TemplateFieldMatch {
  column: number;
  header: string;
  field: StandardField;
}

export interface TabularPreviewRow {
  rowNumber: number;
  values: Partial<Record<StandardField, string>>;
  rawValues?: Partial<Record<StandardField, string>>;
  hyperlinks?: Partial<Record<StandardField, string>>;
  errors: string[];
}

export interface TabularPreview {
  templateVersion: string;
  sourceType: LocalTabularSourceType;
  headerRowNumber: number;
  recognizedFields: TemplateFieldMatch[];
  unknownHeaders: string[];
  missingRequiredFields: StandardField[];
  duplicateHeaders: string[];
  total: number;
  validCount: number;
  invalidCount: number;
  rows: TabularPreviewRow[];
  previewRows: TabularPreviewRow[];
}

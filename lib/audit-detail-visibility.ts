import {
  businessEvidenceLabel,
  businessFailureReasonLabel,
  businessStatusLabel,
  businessTextLabel,
  type StatusLabelDomain,
} from "@/lib/zh-CN";

export interface AuditDetailRuleLike {
  ruleKey?: string | null;
  ruleName?: string | null;
  expectedValue?: string | null;
  actualValue?: string | null;
  failureReason?: string | null;
  evidence?: string | null;
}

const HIDDEN_RULE_KEYS = new Set(["GLOBAL_RETENTION", "PRODUCT_STAGE_BODY"]);
const HIDDEN_DETAIL_TEXT =
  /发布时间|发布日期|作者|15\s*天留存|留存计算|留存|正文段位校验|不参与审核|产品阶段仅用于匹配对应话题/iu;
const HIDDEN_DETAIL_KEY =
  /author|published|publish(?:ed)?(?:At|Date|Time)|retention|bodyStage|requireBodyStage|作者|发布时间|发布日期|留存|正文段位/iu;

export function isAuditDetailTextVisible(value: string | null | undefined) {
  return Boolean(value) && !HIDDEN_DETAIL_TEXT.test(value || "");
}

export function sanitizeAuditDetailText(value: string | null | undefined) {
  if (!value) return "-";
  if (HIDDEN_DETAIL_TEXT.test(value)) return "相关内部信息已隐藏";
  return value.replaceAll("暂无结论", "待人工复核");
}

export function auditDetailFailureReasonLabel(
  value: string | null | undefined,
) {
  return sanitizeAuditDetailText(businessFailureReasonLabel(value));
}

export function auditDetailTextLabel(value: string | null | undefined) {
  return sanitizeAuditDetailText(businessTextLabel(value));
}

export function auditDetailStatusLabel(
  value: string | null | undefined,
  domain: StatusLabelDomain = "common",
) {
  return sanitizeAuditDetailText(businessStatusLabel(value, domain));
}

export function isAuditDetailRuleVisible(rule: AuditDetailRuleLike) {
  if (rule.ruleKey && HIDDEN_RULE_KEYS.has(rule.ruleKey)) return false;
  return [
    rule.ruleName,
    rule.expectedValue,
    rule.actualValue,
    rule.failureReason,
  ].every((value) => !value || isAuditDetailTextVisible(value));
}

export function filterAuditDetailRules<T extends AuditDetailRuleLike>(
  rules: T[],
) {
  return rules.filter(isAuditDetailRuleVisible);
}

export function filterAuditDetailReasons(values: string[]) {
  return values
    .filter(isAuditDetailTextVisible)
    .map(auditDetailFailureReasonLabel);
}

function sanitizeEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(sanitizeEvidenceValue)
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.ruleKey === "string" &&
      (HIDDEN_RULE_KEYS.has(record.ruleKey) ||
        HIDDEN_DETAIL_TEXT.test(record.ruleKey))
    ) {
      return undefined;
    }
    if (
      typeof record.ruleName === "string" &&
      HIDDEN_DETAIL_TEXT.test(record.ruleName)
    ) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !HIDDEN_DETAIL_KEY.test(key))
        .map(([key, item]) => [key, sanitizeEvidenceValue(item)] as const)
        .filter(([, item]) => item !== undefined),
    );
  }
  if (typeof value === "string") {
    if (HIDDEN_DETAIL_TEXT.test(value)) return undefined;
    return value.replaceAll("暂无结论", "待人工复核");
  }
  return value;
}

export function sanitizeAuditDetailEvidence<T>(value: T): T {
  return sanitizeEvidenceValue(value) as T;
}

export function auditDetailEvidenceLabel(value: string | null | undefined) {
  if (!value) return "-";
  try {
    const sanitized = sanitizeEvidenceValue(JSON.parse(value));
    return sanitizeAuditDetailText(
      businessEvidenceLabel(JSON.stringify(sanitized ?? {})),
    );
  } catch {
    return auditDetailTextLabel(value);
  }
}

export function auditDetailJsonForDisplay(value: string | null | undefined) {
  if (!value) return "{}";
  try {
    return JSON.stringify(sanitizeEvidenceValue(JSON.parse(value)) ?? {}, null, 2);
  } catch {
    return sanitizeAuditDetailText(value);
  }
}

export const processStatusLabels: Record<string, string> = {
  WAITING: "等待中",
  PENDING: "等待中",
  QUEUED: "等待中",
  RUNNING: "处理中",
  PROCESSING: "处理中",
  COMPLETED: "已完成",
  COMPLETE: "已完成",
  COMPLETED_WITH_ERRORS: "已完成（含处理失败）",
  FAILED: "处理失败",
  READ_FAILED: "处理失败",
  PAUSED: "已暂停",
  CANCELLED: "已取消",
  NEEDS_REVIEW: "待人工复核",
  LOGIN_EXPIRED: "登录失效",
  SECURITY_RESTRICTED: "等待安全验证",
};

export const auditResultLabels: Record<string, string> = {
  PASSED: "审核通过",
  FAILED: "审核不通过",
  NOTE_NOT_FOUND: "笔记不存在",
  NEEDS_REVIEW: "待人工复核",
  READ_FAILED: "暂无结论",
  PENDING: "暂无结论",
  UNKNOWN: "暂无结论",
};

export const sourceLabels: Record<string, string> = {
  MANUAL: "手动添加",
  EXCEL: "Excel导入",
  AUTO: "自动审核",
  AUTOMATIC: "自动审核",
  PLUGIN: "插件补审",
  EXTENSION: "插件补审",
  RETENTION_RECHECK: "公开留存复查",
  RE_AUDIT: "重新审核",
};

export const sessionStatusLabels: Record<string, string> = {
  READY: "登录可用",
  LOGIN_IN_PROGRESS: "登录中",
  LOGIN_EXPIRED: "登录失效",
  LOGIN_REQUIRED: "需要登录",
  SECURITY_CHECK: "需要安全验证",
  NETWORK_ERROR: "网络异常",
  CHECKING: "检测中",
  UNKNOWN: "尚未登录",
};

export const commonStatusLabels: Record<string, string> = {
  ACTIVE: "启用",
  INACTIVE: "停用",
  ...processStatusLabels,
  ...auditResultLabels,
  NORMAL: "正常",
  NOTE_NOT_FOUND: "笔记不存在",
  NOT_FOUND: "页面失效",
  DELETED: "笔记已删除",
  NO_PERMISSION: "无权限访问",
  LOGIN_EXPIRED: "登录失效",
  LOGIN_REQUIRED: "需要登录",
  SECURITY_VERIFICATION: "需要安全验证",
  SECURITY_RESTRICTED: "等待安全验证",
  NEEDS_CONFIRMATION: "需要人工确认",
  PRESENT: "正文存在",
  EMPTY: "正文为空",
  IMAGE_TEXT: "图文笔记",
  VIDEO_NOTE: "视频笔记",
  VIDEO: "视频",
  SUCCESS: "提取成功",
  IMAGES_READ_FAILED: "图片数量读取失败",
  NOT_CHECKED: "未提取",
  COMPLIANT: "图片数量合规",
  NON_COMPLIANT: "图片数量不合规",
  NOT_REQUIRED: "不适用",
  PUBLIC: "当前公开",
  NOT_PUBLIC: "当前不公开",
  SATISFIED: "已满足",
  NOT_SATISFIED: "未满足",
  ADMIN: "管理员",
  OPERATOR: "运营人员",
  VIEWER: "只读人员",
};

export const pageTypeLabels: Record<string, string> = {
  NOTE_DETAIL: "笔记详情页",
  LOGIN: "登录页",
  SECURITY_CHECK: "安全验证页",
  APP_LAUNCH: "应用唤起页",
  ERROR_PAGE: "错误页",
  SHORT_LINK: "短链接页",
  UNKNOWN: "未识别页面",
};

export const failureReasonLabels: Record<string, string> = {
  NOTE_NOT_FOUND: "笔记不存在",
  PAGE_NOT_FOUND: "页面异常（页面失效）",
  NOTE_DELETED: "页面异常（笔记已删除）",
  NO_PERMISSION: "无权限访问",
  LOGIN_EXPIRED: "小红书登录失效",
  LOGIN_REQUIRED: "需要重新登录小红书",
  LOAD_TIMEOUT: "页面加载超时",
  STRUCTURE_MISMATCH: "页面结构不匹配",
  SECURITY_VERIFICATION: "遇到验证码或安全验证",
  SECURITY_CHECK: "遇到安全验证",
  REDIRECT_FAILED: "短链接未跳转到笔记详情页",
  NETWORK_ERROR: "网络错误",
  PAGE_READ_FAILED: "页面读取失败",
  BODY_NOT_RECOGNIZED: "未识别到正文",
  TOPICS_NOT_RECOGNIZED: "未识别到话题",
  CANCELLED: "任务已取消",
};

export const pageLinkLabels = {
  FINAL: "最终链接",
  ORIGINAL: "原始链接",
} as const;

export const importTypeLabels: Record<string, string> = {
  AUDIT_TASK: "审核任务",
  CAMPAIGN_RULE: "活动规则",
  PRODUCT: "产品资料",
};

export const aiStatusLabels: Record<string, string> = {
  COMPLETED: "已完成",
  DISABLED: "未启用",
  ERROR: "调用失败",
};

export const aiRelevanceLabels: Record<string, string> = {
  RELATED: "内容相关",
  POSSIBLY_RELATED: "可能相关",
  UNRELATED: "内容不相关",
  UNKNOWN: "未判断",
};

export const settingKeyLabels: Record<string, string> = {
  AI_ENABLED: "启用 AI 辅助判断",
  AUTOMATION_INTERVAL_MS: "自动审核访问间隔（毫秒）",
  EXTENSION_TOKEN: "插件提交令牌",
};

export const topicCategoryLabels: Record<string, string> = {
  BRAND_COMMON: "品牌通用话题",
  PRODUCT_COMMON: "产品话题",
  PRODUCT_STAGE: "产品阶段话题",
  POPULAR: "热门话题",
  GENERAL: "通用话题",
  ALIAS: "话题别名",
};

export const ruleTypeLabels: Record<string, string> = {
  MUST_ALL: "必须全部包含",
  REQUIRED: "必须全部包含",
  ANY: "任意包含",
  FORBIDDEN: "禁止出现",
  BRAND_COMMON: "品牌通用话题",
  ALIAS: "话题别名",
};

export const ruleScopeLabels: Record<string, string> = {
  GLOBAL: "全局",
  PRODUCT: "产品",
  CAMPAIGN: "活动",
};

export const evidenceFieldLabels: Record<string, string> = {
  url: "笔记链接",
  pageStatus: "页面状态",
  noteType: "笔记类型",
  imageExtractionStatus: "图片数量提取状态",
  imageCount: "图片数量",
  minImageCount: "最低图片数量",
  rawBodyLength: "原始正文字数",
  effectiveBodyLength: "有效正文字数",
  excluded: "不计入字符",
  productStageTopic: "产品阶段话题",
  allowedStages: "正文允许段位",
  detectedStages: "正文实际识别段位",
  matchedAllowedStages: "正文命中段位",
  requiredStageTopic: "要求阶段话题",
  isPublic: "是否公开",
  publishedAt: "发布时间",
  retentionDays: "最低留存天数",
  dueAt: "留存复查时间",
  match: "命中话题",
  expected: "要求话题",
  detectedTopics: "识别到的话题",
  dom: "页面元素",
  displayText: "显示文字",
  isLinkElement: "是否为链接元素",
  hasHref: "是否存在跳转地址",
  href: "跳转地址",
  textColor: "文字颜色",
  styleFeature: "是否符合样式特征",
  finalClickable: "最终是否可点击",
  isClickable: "是否可点击",
  domPath: "页面元素路径",
  expectedTopics: "候选话题",
  matchedCount: "命中数量",
};

export const businessUiText = {
  secureBrowserSession: "小红书专用浏览器",
  taskConfiguration: "任务配置",
  bulkIngestion: "批量导入",
  manualEvidence: "人工补审证据",
  auditOperations: "审核进度",
  executionLog: "审核执行记录",
  recentActivity: "本次任务内容",
  remaining: "剩余数量",
  riskSummary: "风险摘要",
  auditTrend: "审核趋势",
  resultMix: "审核结果分布",
  topRisks: "主要风险",
  actionCenter: "待处理事项",
  records: "条记录",
  noIssue: "无异常",
  contentOk: "内容正常",
  ruleMatch: "规则匹配",
  pendingConclusion: "暂无结论",
} as const;

export type StatusLabelDomain =
  | "common"
  | "process"
  | "audit"
  | "session";

export function businessStatusLabel(
  value: string | null | undefined,
  domain: StatusLabelDomain = "common",
) {
  if (!value) return "-";
  const maps = {
    common: commonStatusLabels,
    process: processStatusLabels,
    audit: auditResultLabels,
    session: sessionStatusLabels,
  };
  return maps[domain][value] || commonStatusLabels[value] || value;
}

export function businessSourceLabel(value: string | null | undefined) {
  if (!value) return "-";
  return sourceLabels[value] || value;
}

export function businessPageTypeLabel(value: string | null | undefined) {
  if (!value) return "-";
  return pageTypeLabels[value] || value;
}

export function businessImportTypeLabel(value: string | null | undefined) {
  if (!value) return "-";
  return importTypeLabels[value] || value;
}

export function settingLabel(value: string | null | undefined) {
  if (!value) return "-";
  return settingKeyLabels[value] || value;
}

export function businessFailureReasonLabel(
  value: string | null | undefined,
) {
  if (!value) return "-";
  return Object.entries(failureReasonLabels).reduce(
    (text, [code, label]) => text.replaceAll(code, label),
    value,
  );
}

export function businessTextLabel(value: string | null | undefined) {
  if (!value) return "-";
  const embeddedLabels = {
    ...commonStatusLabels,
    ...processStatusLabels,
    ...auditResultLabels,
    ...sourceLabels,
    ...sessionStatusLabels,
    ...pageTypeLabels,
    ...aiStatusLabels,
    ...aiRelevanceLabels,
  };
  return Object.entries(embeddedLabels)
    .sort(([left], [right]) => right.length - left.length)
    .reduce(
      (text, [code, label]) =>
        text.replace(new RegExp(`\\b${code}\\b`, "gu"), label),
      value,
    );
}

function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return "无";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return businessTextLabel(value);
  if (Array.isArray(value)) {
    return value.length
      ? value.map((item) => formatEvidenceValue(item)).join("、")
      : "无";
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(
        ([key, item]) =>
          `${evidenceFieldLabels[key] || `内部字段（${key}）`}：${formatEvidenceValue(item)}`,
      )
      .join("；");
  }
  return String(value);
}

export function businessEvidenceLabel(value: string | null | undefined) {
  if (!value) return "-";
  try {
    return formatEvidenceValue(JSON.parse(value));
  } catch {
    return businessTextLabel(value);
  }
}

export function internalStatusValue(
  value: string | null | undefined,
  fallback = "ACTIVE",
) {
  if (!value) return fallback;
  const matched = Object.entries(commonStatusLabels).find(
    ([, label]) => label === value,
  );
  return matched?.[0] || value;
}

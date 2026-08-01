import builtinTemplateJson from "@/rules/default-import-export-templates.json";
import { prisma } from "@/lib/db";
import type { ImportExportTemplates } from "./types";
import { validateImportExportTemplates } from "./validation";

const requiredFailureExportFields = {
  failedReasons: {
    displayName: "不通过原因",
    type: "stringList" as const,
    description: "未通过或待复核原因",
  },
  originalUrl: {
    displayName: "原始链接",
    type: "url" as const,
    description: "任务提交时保存的原始笔记链接",
  },
  finalUrl: {
    displayName: "最终链接",
    type: "url" as const,
    description: "短链接完成跳转后的最终页面链接",
  },
  exceptionCategory: {
    displayName: "异常分类",
    type: "string" as const,
    description: "页面访问或自动提取的异常分类",
  },
  failureReason: {
    displayName: "失败原因",
    type: "string" as const,
    description: "处理失败或待人工复核的具体原因",
  },
  needsManualReview: {
    displayName: "是否需要人工复核",
    type: "string" as const,
    description: "当前结果是否需要人工确认",
  },
  manualReviewStatus: {
    displayName: "人工复核状态",
    type: "string" as const,
    description: "待人工复核、已人工通过、已人工不通过或无需复核",
  },
  attemptCount: {
    displayName: "尝试次数",
    type: "integer" as const,
    description: "自动处理该笔记的累计尝试次数",
  },
  auditCreatedAt: {
    displayName: "审核创建时间",
    type: "datetime" as const,
    description: "审核结果记录创建时间",
  },
  auditCompletedAt: {
    displayName: "审核完成时间",
    type: "datetime" as const,
    description: "自动审核执行完成时间",
  },
  taskCreatedAt: {
    displayName: "任务创建时间",
    type: "datetime" as const,
    description: "审核任务进入系统的时间",
  },
  dateFilterBasis: {
    displayName: "日期筛选口径",
    type: "string" as const,
    description: "本次导出使用的日期范围筛选字段",
  },
  pageStatus: {
    displayName: "页面状态",
    type: "string" as const,
    description: "笔记页面访问和读取状态",
  },
  bodyStatus: {
    displayName: "正文状态",
    type: "string" as const,
    description: "笔记正文提取状态",
  },
  topicsAuditResult: {
    displayName: "话题审核结果",
    type: "string" as const,
    description: "要求话题的审核结果",
  },
  autoAuditResult: {
    displayName: "自动审核结果",
    type: "string" as const,
    description: "固定规则自动审核结论",
  },
  manualAuditResult: {
    displayName: "人工复核结果",
    type: "string" as const,
    description: "最近一次人工复核结论",
  },
  finalAuditConclusion: {
    displayName: "最终审核结论",
    type: "string" as const,
    description: "人工复核优先的最终审核结论",
  },
  manualReviewComment: {
    displayName: "人工复核备注",
    type: "string" as const,
    description: "最近一次人工复核备注",
  },
  auditTime: {
    displayName: "审核时间",
    type: "datetime" as const,
    description: "自动审核完成时间",
  },
};

function ensureFailureExportFields(
  templates: ImportExportTemplates,
): ImportExportTemplates {
  const output = structuredClone(templates);
  output.fieldDefinitions.contentChannel = {
    displayName: "内容渠道",
    type: "string",
    description: "内容发布平台，例如小红书或抖音",
  };
  output.fieldAliases.contentChannel = [
    "内容渠道",
    "发布渠道",
    "平台",
    "内容平台",
    "channel",
    "platform",
  ];
  if (!output.optionalFields.includes("contentChannel")) {
    output.optionalFields.push("contentChannel");
  }
  if (!output.columnOrder.import.includes("contentChannel")) {
    output.columnOrder.import.splice(1, 0, "contentChannel");
  }
  Object.assign(output.fieldDefinitions, requiredFailureExportFields);
  const required = Object.keys(
    requiredFailureExportFields,
  ) as Array<keyof typeof requiredFailureExportFields>;
  for (const field of required) {
    if (!output.columnOrder.auditResults.includes(field)) {
      output.columnOrder.auditResults.push(field);
    }
  }
  return output;
}

export const BUILTIN_IMPORT_EXPORT_TEMPLATES =
  ensureFailureExportFields(
    validateImportExportTemplates(builtinTemplateJson),
  );

export async function getActiveImportExportTemplates(): Promise<{
  templates: ImportExportTemplates;
  source: "BUILTIN" | "RULE_PACKAGE";
  ruleVersion: string | null;
}> {
  try {
    const state = await prisma.ruleSyncState.findUnique({
      where: { id: "active" },
      select: {
        currentVersion: true,
        templateConfigJson: true,
      },
    });
    if (state?.templateConfigJson) {
      return {
        templates: ensureFailureExportFields(
          validateImportExportTemplates(
            JSON.parse(state.templateConfigJson),
          ),
        ),
        source: "RULE_PACKAGE",
        ruleVersion: state.currentVersion,
      };
    }
    return {
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      source: "BUILTIN",
      ruleVersion: state?.currentVersion || null,
    };
  } catch {
    return {
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      source: "BUILTIN",
      ruleVersion: null,
    };
  }
}

import builtinTemplateJson from "@/rules/default-import-export-templates.json";
import { prisma } from "@/lib/db";
import type { ImportExportTemplates, StandardField } from "./types";
import { validateImportExportTemplates } from "./validation";

export const RESULT_EXPORT_FIELDS: StandardField[] = [
  "productName",
  "activityName",
  "productStageTopic",
  "requiredStageTopic",
  "finalAuditConclusion",
  "manualReviewStatus",
  "failedReasons",
  "effectiveBodyLength",
  "imageCount",
  "topicsAuditResult",
  "publicStatus",
  "content",
];

export const IMPORT_TEMPLATE_FIELDS: StandardField[] = [
  "noteUrl",
  "productName",
  "activityName",
  "productStage",
];

function normalizeBusinessTemplates(
  templates: ImportExportTemplates,
): ImportExportTemplates {
  const output = structuredClone(templates);
  output.fieldDefinitions.failedReasons = {
    displayName: "失败原因",
    type: "stringList",
    description: "未通过或待复核原因",
  };
  output.fieldDefinitions.effectiveBodyLength = {
    displayName: "正文有效字数",
    type: "integer",
    description: "固定规则计算后的有效正文字符数",
  };
  output.fieldDefinitions.publicStatus = {
    displayName: "当前公开状态",
    type: "string",
    description: "审核时识别的笔记公开状态",
  };
  output.requiredFields = ["noteUrl", "productName", "activityName"];
  output.optionalFields = [
    ...new Set([
      ...output.optionalFields,
      "productStage" as const,
      "effectiveBodyLength" as const,
      "publicStatus" as const,
    ]),
  ];
  output.columnOrder.import = [...IMPORT_TEMPLATE_FIELDS];
  output.columnOrder.auditResults = [...RESULT_EXPORT_FIELDS];
  return output;
}

export const BUILTIN_IMPORT_EXPORT_TEMPLATES =
  normalizeBusinessTemplates(
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
        templates: normalizeBusinessTemplates(
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

import builtinTemplateJson from "@/rules/default-import-export-templates.json";
import { prisma } from "@/lib/db";
import type { ImportExportTemplates, StandardField } from "./types";
import { validateImportExportTemplates } from "./validation";

export const RESULT_EXPORT_FIELDS: StandardField[] = [
  "commercePlatform",
  "shopName",
  "customerName",
  "productName",
  "productStageTopic",
  "orderNumber",
  "contentChannel",
  "originalUrl",
  "publishTime",
  "selfReview",
];

export const IMPORT_TEMPLATE_FIELDS: StandardField[] = [
  "commercePlatform",
  "shopName",
  "customerName",
  "productName",
  "productStage",
  "orderNumber",
  "contentChannel",
  "noteUrl",
  "publishTime",
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
  output.fieldDefinitions.productName = {
    displayName: "产品系列（必填）",
    type: "string",
    description: "系统中已有的产品名称、产品系列或简称",
  };
  output.fieldDefinitions.commercePlatform = {
    displayName: "平台",
    type: "string",
    description: "订单所在成交平台；未填写时仅可由店铺全称精确推断",
  };
  output.fieldDefinitions.shopName = {
    displayName: "店铺名称（必填）",
    type: "string",
    description: "线下表格中的店铺名称，仅用于记录和导出",
  };
  output.fieldDefinitions.customerName = {
    displayName: "客户名（必填）",
    type: "string",
    description: "线下表格中的客户名，仅用于记录和导出",
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
  output.fieldDefinitions.productStage = {
    displayName: "阶段（IFFO/GUM）",
    type: "string",
    description: "必填，只填写 IFFO 或 GUM",
  };
  output.fieldDefinitions.orderNumber = {
    displayName: "订单编号",
    type: "string",
    description: "可选，用于和原始表格对照，不参与审核判断",
  };
  output.fieldDefinitions.contentChannel = {
    displayName: "内容渠道",
    type: "string",
    description: "内容来源渠道；未填写时仅由笔记链接类型识别",
  };
  output.fieldDefinitions.noteUrl = {
    displayName: "链接（必填）",
    type: "url",
    description: "小红书完整链接或 xhslink 短链接",
  };
  output.fieldDefinitions.publishTime = {
    displayName: "发帖时间（必填）",
    type: "datetime",
    description: "线下表格中的发帖时间，仅用于记录和导出",
  };
  output.fieldDefinitions.productStageTopic = {
    displayName: "阶段",
    type: "string",
    description: "审核任务选择的产品阶段",
  };
  output.fieldDefinitions.originalUrl = {
    displayName: "链接",
    type: "url",
    description: "导入时使用的原始笔记链接",
  };
  output.fieldDefinitions.pageStatus = {
    displayName: "笔记状态",
    type: "string",
    description: "笔记页面访问和读取状态",
  };
  output.fieldDefinitions.topicsAuditResult = {
    displayName: "话题审核",
    type: "string",
    description: "要求话题的审核结果",
  };
  output.fieldDefinitions.imageStatus = {
    displayName: "图片",
    type: "string",
    description: "识别到的图片数量及合规状态",
  };
  output.fieldDefinitions.finalAuditConclusion = {
    displayName: "审核结论",
    type: "string",
    description: "人工复核优先的最终审核结论",
  };
  output.fieldDefinitions.selfReview = {
    displayName: "自审",
    type: "string",
    description: "供客服或运营人工筛选和调整",
  };
  output.fieldAliases.orderNumber = [
    "订单编号",
    "订单号",
    "订单编号（必填）",
    "orderNumber",
  ];
  output.fieldAliases.commercePlatform = [
    "平台",
    "平台（必填）",
    "成交平台",
    "电商平台",
    "订单平台",
    "commercePlatform",
  ];
  output.fieldAliases.shopName = [
    "店铺名称",
    "店铺名称（必填）",
    "店铺",
    "shopName",
  ];
  output.fieldAliases.customerName = [
    "客户名",
    "客户名（必填）",
    "客户名称",
    "customerName",
  ];
  output.fieldAliases.contentChannel = [
    ...new Set(
      [
        ...(output.fieldAliases.contentChannel || []),
        "内容渠道",
        "内容渠道（必填）",
        "渠道",
        "审核渠道",
        "发布渠道",
        "channel",
      ].filter((alias) => alias !== "平台" && alias !== "platform"),
    ),
  ];
  output.fieldAliases.noteUrl = [
    ...new Set([
      ...(output.fieldAliases.noteUrl || []),
      "链接（必填）",
      "链接",
    ]),
  ];
  output.fieldAliases.productName = [
    ...new Set([
      ...(output.fieldAliases.productName || []),
      "产品系列",
      "产品系列（必填）",
    ]),
  ];
  output.fieldAliases.productStage = [
    ...new Set([
      ...(output.fieldAliases.productStage || []),
      "阶段",
      "阶段（IFFO/GUM）",
    ]),
  ];
  output.fieldAliases.publishTime = [
    ...new Set([
      ...(output.fieldAliases.publishTime || []),
      "发帖时间",
      "发帖时间（必填）",
      "发布时间",
    ]),
  ];
  output.examples.commercePlatform = "京东";
  output.examples.shopName = "京东健康官方进口超市";
  output.examples.customerName = "示例客户";
  output.examples.productStage = "IFFO";
  output.examples.orderNumber = "JD202608030001";
  output.examples.contentChannel = "小红书";
  output.examples.noteUrl = "https://xhslink.com/示例短链";
  output.examples.publishTime = "2026-08-03 12:00:00";
  output.requiredFields = [
    "shopName",
    "customerName",
    "noteUrl",
    "productName",
    "productStage",
    "publishTime",
  ];
  output.optionalFields = [
    ...new Set([
      ...output.optionalFields.filter(
        (field) => !output.requiredFields.includes(field),
      ),
      "orderNumber" as const,
      "commercePlatform" as const,
      "contentChannel" as const,
      "activityName" as const,
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

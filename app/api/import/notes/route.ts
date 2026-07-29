import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { cellText } from "@/lib/excel";
import { isSupportedNoteUrl, normalizeUrl } from "@/lib/topic";
import { fail, ok, requireApiUser } from "@/lib/api";
import { createAutomaticBatch } from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import {
  detectProductStage,
  normalizeProductStageTopicValue,
  resolveConfiguredProductStage,
} from "@/lib/product-stage";

interface CheckedRow {
  rowNumber: number;
  url: string;
  productCode: string;
  productName: string;
  campaignName: string;
  month: string;
  specification: string;
  stageInput: string;
  productStage: string;
  stageGroup: string;
  notes: string;
  productId?: string;
  campaignId?: string;
  milkType?: string;
  errors: string[];
}

export async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
  if (user instanceof Response) return user;
  const form = await request.formData();
  const file = form.get("file");
  const commit = form.get("commit") === "true";
  const skipDuplicates = form.get("skipDuplicates") !== "false";
  if (!(file instanceof File)) return fail("请选择 Excel 文件");
  if (file.size > 10 * 1024 * 1024) return fail("文件不能超过 10MB");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) return fail("Excel 中没有工作表");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => headers.set(cellText(cell), col));
  const required = [
    "笔记链接",
    "产品名称",
    "活动名称",
    "活动月份",
  ];
  const missingHeaders = required.filter((item) => !headers.has(item));
  if (missingHeaders.length) return fail(`缺少模板列：${missingHeaders.join("、")}`);

  const rows: CheckedRow[] = [];
  const seen = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const get = (header: string) => {
      const column = headers.get(header);
      return column ? cellText(row.getCell(column)) : "";
    };
    const checked: CheckedRow = {
      rowNumber,
      url: get("笔记链接"),
      productCode: get("产品编码"),
      productName: get("产品名称"),
      campaignName: get("活动名称"),
      month: get("活动月份"),
      specification: get("规格") || get("产品规格"),
      stageInput:
        get("产品阶段话题") ||
        get("产品段位") ||
        get("奶粉段位") ||
        get("段位"),
      productStage: "",
      stageGroup: "",
      notes: get("备注"),
      errors: [],
    };
    if (!checked.url && !checked.productCode && !checked.productName) continue;
    if (!checked.url) checked.errors.push("链接为空");
    else if (!isSupportedNoteUrl(checked.url)) checked.errors.push("链接格式不正确");
    let normalizedUrl = "";
    if (checked.url && isSupportedNoteUrl(checked.url)) {
      normalizedUrl = normalizeUrl(checked.url);
      if (seen.has(normalizedUrl)) checked.errors.push("文件内存在重复链接");
      seen.add(normalizedUrl);
    }
    const product = await prisma.product.findFirst({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        OR: [
          ...(checked.productCode ? [{ code: checked.productCode }] : []),
          ...(checked.productName ? [{ name: checked.productName }] : []),
        ],
      },
    });
    if (!product) checked.errors.push("产品不存在");
    else checked.productId = product.id;
    const campaign = product
      ? await prisma.campaign.findFirst({
          where: {
            name: checked.campaignName,
            month: checked.month,
            status: "ACTIVE",
            OR: [
              { productId: product.id },
              { products: { some: { productId: product.id } } },
            ],
          },
        })
      : null;
    if (!campaign) checked.errors.push("活动不存在或与产品/月度不匹配");
    else checked.campaignId = campaign.id;
    const stageDetection = detectProductStage([
      checked.productName,
      checked.specification,
      checked.stageInput,
    ]);
    checked.stageGroup = stageDetection.groupLabel || "";
    if (stageDetection.status === "CONFLICT") {
      checked.errors.push(
        `段位信息冲突：${stageDetection.matchedStages.join("、")}，请人工确认`,
      );
    }
    const stageRules = campaign
      ? await prisma.topicRule.findMany({
          where: {
            campaignId: campaign.id,
            topicCategory: "PRODUCT_STAGE",
            status: "ACTIVE",
          },
          select: {
            applicableStage: true,
            milkType: true,
          },
        })
      : [];
    const resolvedStage = resolveConfiguredProductStage(
      stageDetection,
      stageRules.map((rule) => rule.applicableStage),
    );
    const stageRule = resolvedStage
      ? stageRules.find(
          (rule) =>
            normalizeProductStageTopicValue(rule.applicableStage) ===
            resolvedStage,
        )
      : null;
    if (stageDetection.status === "MATCHED") {
      checked.productStage = stageDetection.group || "";
    }
    if (stageRules.length && stageDetection.status === "MISSING") {
      checked.errors.push("段位未识别：请在产品阶段话题中填写有效段位");
    } else if (
      stageRules.length &&
      stageDetection.status === "MATCHED" &&
      !stageRule
    ) {
      checked.errors.push(
        `活动未配置${stageDetection.groupLabel || "对应"}的产品阶段话题规则`,
      );
    }
    checked.milkType = stageRule?.milkType || undefined;
    if (normalizedUrl) {
      const existing = await prisma.auditTask.findFirst({
        where: { normalizedUrl, campaignId: campaign?.id },
        include: { auditResults: { take: 1 } },
      });
      if (existing?.auditResults.length) checked.errors.push("同一链接已完成审核");
      else if (existing) checked.errors.push("同一链接已有待审核任务");
    }
    rows.push(checked);
  }

  const validRows = rows.filter((row) => row.errors.length === 0);
  let imported = 0;
  let batchId: string | null = null;
  if (commit) {
    if (validRows.length) {
      const productIds = [...new Set(validRows.map((row) => row.productId!))];
      const campaignIds = [...new Set(validRows.map((row) => row.campaignId!))];
      const batch = await createAutomaticBatch({
        name: `Excel 自动审核 · ${file.name}`,
        source: "EXCEL",
        createdBy: user.id,
        productId: productIds.length === 1 ? productIds[0] : undefined,
        campaignId: campaignIds.length === 1 ? campaignIds[0] : undefined,
        tasks: validRows.map((row) => ({
          url: row.url,
          productId: row.productId!,
          campaignId: row.campaignId!,
          productStage: row.productStage,
          milkType: row.milkType,
          source: "EXCEL",
          notes: row.notes,
        })),
      });
      batchId = batch.id;
      imported = validRows.length;
      kickAutomaticAuditQueue();
    }
    await prisma.importRecord.create({
      data: {
        fileName: file.name,
        importType: "AUDIT_TASK",
        totalCount: rows.length,
        validCount: validRows.length,
        invalidCount: rows.length - validRows.length,
        skippedCount: skipDuplicates ? rows.length - validRows.length : 0,
        status: "COMPLETED",
        summary: JSON.stringify({
          errors: rows
            .filter((row) => row.errors.length)
            .map((row) => ({ row: row.rowNumber, errors: row.errors })),
        }),
        createdBy: user.id,
      },
    });
  }
  return ok({
    total: rows.length,
    validCount: validRows.length,
    invalidCount: rows.length - validRows.length,
    imported,
    batchId,
    skipDuplicates,
    rows,
  });
}

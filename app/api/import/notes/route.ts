import { prisma } from "@/lib/db";
import {
  resolveImportedNoteLink,
  type NoteLinkPlatform,
} from "@/lib/note-links";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  createAutomaticBatchInTransaction,
  type AutomaticTaskInput,
} from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import {
  compatibleStageRuleValues,
  normalizeImportedProductStageTopicValue,
  productStageTopicLabel,
} from "@/lib/product-stage";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  detectLocalSourceType,
  parseTabularPreview,
} from "@/lib/import-export-templates/tabular";
import {
  KABRITA_BRAND_NAME,
  inferKabritaProductStage,
  kabritaRawValues,
} from "@/lib/import-export-templates/kabrita";
import {
  auditNoteIdentity,
  findBlockingAuditTasks,
  importedAuditTaskDuplicateMessage,
} from "@/lib/audit-task-deduplication";
import {
  productResolutionError,
  resolveProductReference,
} from "@/lib/product-matching";
import { buildImportedTaskNotes } from "@/lib/import-task-metadata";

interface CheckedRow {
  rowNumber: number;
  url: string;
  originalLinkContent: string;
  importedPlatform: string;
  shopName: string;
  customerName: string;
  contentChannel: string;
  orderNumber: string;
  publishTime: string;
  platform: NoteLinkPlatform;
  recognitionStatus: "RECOGNIZED" | "UNRECOGNIZED" | "UNSUPPORTED";
  failureReason: string;
  productCode: string;
  productName: string;
  purchaseProductLine: string;
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

const IMPORT_PREVIEW_ROW_LIMIT = 100;

export async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const form = await request.formData();
  const file = form.get("file");
  const commit = form.get("commit") === "true";
  const skipDuplicates = form.get("skipDuplicates") !== "false";
  const declaredTencentExport =
    form.get("tencentExport") === "true" ||
    (file instanceof File && /腾讯|tencent/iu.test(file.name));
  if (!(file instanceof File)) {
    return fail("请选择 Excel、CSV 或腾讯文档导出的表格文件");
  }

  try {
    const { templates } = await getActiveImportExportTemplates();
    const sourceType = detectLocalSourceType(file.name, declaredTencentExport);
    const tabular = await parseTabularPreview({
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      sourceType,
      templates,
    });
    const rows: CheckedRow[] = [];
    const seen = new Set<string>();
    const isKabritaTemplate = tabular.templateBrand === KABRITA_BRAND_NAME;
    const hasContentChannelColumn = tabular.recognizedFields.some(
      (field) => field.field === "contentChannel",
    );
    const activeProducts = await prisma.product.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      include: { aliases: { select: { alias: true } } },
    });
    const campaignCache = new Map<
      string,
      Awaited<ReturnType<typeof prisma.campaign.findFirst>>
    >();
    const stageRulesCache = new Map<
      string,
      Array<{ applicableStage: string | null; milkType: string | null }>
    >();

    for (const parsed of tabular.rows) {
      const values = parsed.values;
      const originalLinkContent =
        (isKabritaTemplate
          ? parsed.rawValues?.xiaohongshuPublishLink ||
            values.xiaohongshuPublishLink
          : parsed.rawValues?.noteUrl || values.noteUrl) || "";
      const hyperlinkTarget = isKabritaTemplate
        ? parsed.hyperlinks?.xiaohongshuPublishLink || ""
        : parsed.hyperlinks?.noteUrl || "";
      const declaredChannel = isKabritaTemplate
        ? ""
        : (values.contentChannel || "").trim();
      const purchaseProductLine = isKabritaTemplate
        ? values.purchaseProductLine || ""
        : "";
      const linkResolution = resolveImportedNoteLink({
        rawContent: originalLinkContent,
        hyperlinkTarget,
        declaredChannel,
      });
      const checked: CheckedRow = {
        rowNumber: parsed.rowNumber,
        url: linkResolution.url,
        originalLinkContent: linkResolution.originalContent,
        importedPlatform: isKabritaTemplate ? "小红书" : values.platform || "",
        shopName: values.shopName || "",
        customerName: isKabritaTemplate
          ? values.customerRemark || ""
          : values.customerName || "",
        contentChannel: isKabritaTemplate ? "小红书" : declaredChannel,
        orderNumber: isKabritaTemplate
          ? values.purchaseOrderNumber || ""
          : values.orderNumber || "",
        publishTime: isKabritaTemplate
          ? values.purchaseTime || ""
          : values.publishTime || "",
        platform: linkResolution.platform,
        recognitionStatus: linkResolution.status,
        failureReason: linkResolution.failureReason,
        productCode: values.productCode || "",
        productName: isKabritaTemplate
          ? purchaseProductLine
          : values.productName || "",
        purchaseProductLine,
        campaignName: values.activityName || "",
        month: values.activityMonth || "",
        specification: values.specification || "",
        stageInput: isKabritaTemplate
          ? inferKabritaProductStage(purchaseProductLine)
          : values.productStage || "",
        productStage: "",
        stageGroup: "",
        notes: buildImportedTaskNotes({
          platform: isKabritaTemplate ? "小红书" : values.platform,
          shopName: values.shopName,
          customerName: isKabritaTemplate
            ? values.customerRemark
            : values.customerName,
          orderNumber: isKabritaTemplate
            ? values.purchaseOrderNumber
            : values.orderNumber,
          contentChannel: isKabritaTemplate
            ? "小红书"
            : values.contentChannel,
          publishTime: isKabritaTemplate
            ? values.purchaseTime
            : values.publishTime,
          notes: values.remark,
          ...(isKabritaTemplate
            ? {
                templateMetadata: {
                  templateBrand: KABRITA_BRAND_NAME,
                  rawValues: kabritaRawValues(parsed.rawValues || values),
                },
              }
            : {}),
        }),
        errors: [...parsed.errors],
      };
      if (!isKabritaTemplate && hasContentChannelColumn && !declaredChannel) {
        checked.errors.push("内容渠道不能为空");
      }
      if (checked.failureReason) {
        checked.errors.push(checked.failureReason);
      }
      if (checked.url && checked.recognitionStatus === "RECOGNIZED") {
        const identity = auditNoteIdentity(checked.url);
        if (seen.has(identity)) checked.errors.push("文件内存在重复链接");
        seen.add(identity);
      }
      const matchingProducts = isKabritaTemplate
        ? activeProducts.filter(
            (product) => product.brandName.trim() === KABRITA_BRAND_NAME,
          )
        : activeProducts;
      const productResolution = resolveProductReference(matchingProducts, {
        code: checked.productCode,
        name: checked.productName,
      });
      const product =
        productResolution.status === "MATCHED"
          ? productResolution.product
          : null;
      if (!product) {
        checked.errors.push(productResolutionError(productResolution));
      } else {
        checked.productId = product.id;
        checked.productName = product.name;
        checked.productCode = product.code || checked.productCode;
        if (!product.brandName.trim()) {
          checked.errors.push("产品未配置品牌，无法加载话题规则");
        }
      }

      const campaignKey = product
        ? [product.id, checked.campaignName, checked.month].join("\u0000")
        : "";
      let campaign = product ? campaignCache.get(campaignKey) : null;
      if (product && !campaignCache.has(campaignKey)) {
        campaign = await prisma.campaign.findFirst({
          where: {
            ...(checked.campaignName ? { name: checked.campaignName } : {}),
            ...(checked.month ? { month: checked.month } : {}),
            status: "ACTIVE",
            OR: [
              { productId: product.id },
              { products: { some: { productId: product.id } } },
            ],
          },
          orderBy: [{ endDate: "desc" }, { updatedAt: "desc" }],
        });
        campaignCache.set(campaignKey, campaign);
      }
      if (!campaign) {
        checked.errors.push("活动不存在或与产品不匹配");
      } else {
        checked.campaignId = campaign.id;
        checked.campaignName = campaign.name;
        checked.month = campaign.month;
      }

      const importedStage = normalizeImportedProductStageTopicValue(
        checked.stageInput,
      );
      checked.productStage = importedStage || "";
      checked.stageGroup = importedStage
        ? productStageTopicLabel(importedStage)
        : "";
      if (!isKabritaTemplate && !importedStage) {
        checked.errors.push("产品阶段话题请填写 IFFO 或 GUM。");
      }
      const stageRulesKey = campaign?.id || "";
      let stageRules = stageRulesCache.get(stageRulesKey) || [];
      if (
        campaign &&
        product?.brandName.trim() &&
        !stageRulesCache.has(stageRulesKey)
      ) {
        stageRules = await prisma.topicRule.findMany({
          where: {
            brandName: product.brandName,
            campaignId: campaign.id,
            topicCategory: "PRODUCT_STAGE",
            status: "ACTIVE",
          },
          select: { applicableStage: true, milkType: true },
        });
        stageRulesCache.set(stageRulesKey, stageRules);
      }
      const compatibleStages = compatibleStageRuleValues(importedStage);
      const stageRule = importedStage
        ? stageRules.find(
            (rule) => compatibleStages.includes(rule.applicableStage || ""),
          )
        : null;
      if (stageRules.length && importedStage && !stageRule) {
        checked.errors.push(
          `活动未配置 ${productStageTopicLabel(importedStage)} 的产品阶段话题规则`,
        );
      }
      checked.milkType = stageRule?.milkType || undefined;
      checked.errors = [...new Set(checked.errors)];
      rows.push(checked);
    }

    const duplicateCandidates = rows
      .filter((row) => row.url && row.campaignId)
      .map((row) => row.url);
    const blockingTasks = await findBlockingAuditTasks({
      urls: duplicateCandidates,
    });
    for (const row of rows) {
      if (blockingTasks.has(row.url)) {
        row.errors = [
          ...new Set([...row.errors, importedAuditTaskDuplicateMessage]),
        ];
      }
    }

    const validRows = rows.filter((row) => row.errors.length === 0);
    let imported = 0;
    let batchId: string | null = null;
    if (commit) {
      if (!validRows.length) return fail("没有可导入的有效数据行");
      const productIds = [...new Set(validRows.map((row) => row.productId!))];
      const campaignIds = [
        ...new Set(validRows.map((row) => row.campaignId!)),
      ];
      const syncState = await prisma.ruleSyncState.findUnique({
        where: { id: "active" },
        select: { currentVersion: true },
      });
      const committed = await prisma.$transaction(
        async (tx) => {
          const tasks: AutomaticTaskInput[] = validRows.map((row) => ({
            url: row.url,
            originalInput: row.originalLinkContent,
            productId: row.productId!,
            campaignId: row.campaignId!,
            productStage: row.productStage,
            milkType: row.milkType,
            source: "EXCEL",
            notes: row.notes,
          }));
          const batch = await createAutomaticBatchInTransaction(
            tx,
            {
              name: `表格自动审核 · ${file.name}`,
              source: "EXCEL",
              createdBy: user.id,
              productId: productIds.length === 1 ? productIds[0] : undefined,
              campaignId: campaignIds.length === 1 ? campaignIds[0] : undefined,
              tasks,
            },
            syncState?.currentVersion || null,
          );
          await tx.importRecord.create({
            data: {
              fileName: file.name,
              importType: "AUDIT_TASK",
              totalCount: rows.length,
              validCount: validRows.length,
              invalidCount: rows.length - validRows.length,
              skippedCount: skipDuplicates
                ? rows.length - validRows.length
                : 0,
              status: "COMPLETED",
              summary: JSON.stringify({
                templateVersion: tabular.templateVersion,
                templateBrand: tabular.templateBrand,
                sourceType,
                errors: rows
                  .filter((row) => row.errors.length)
                  .map((row) => ({
                    row: row.rowNumber,
                    errors: row.errors,
                  })),
              }),
              createdBy: user.id,
            },
          });
          return batch;
        },
        { timeout: 60_000 },
      );
      batchId = committed.id;
      imported = validRows.length;
      kickAutomaticAuditQueue();
    }

    return ok({
      ...tabular,
      missingRequiredFields: tabular.missingRequiredFields.map(
        (field) => templates.fieldDefinitions[field].displayName,
      ),
      validCount: validRows.length,
      invalidCount: rows.length - validRows.length,
      imported,
      batchId,
      skipDuplicates,
      rows: rows.slice(0, IMPORT_PREVIEW_ROW_LIMIT),
      rowsTruncated: rows.length > IMPORT_PREVIEW_ROW_LIMIT,
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "无法读取表格",
    );
  }
}

import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";
import {
  resolveImportedNoteLink,
  type NoteLinkPlatform,
} from "@/lib/note-links";
import { fail, ok, requireApiUser } from "@/lib/api";
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
  auditNoteIdentity,
  findBlockingAuditTask,
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
    const hasContentChannelColumn = tabular.recognizedFields.some(
      (field) => field.field === "contentChannel",
    );
    const activeProducts = await prisma.product.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      include: { aliases: { select: { alias: true } } },
    });

    for (const parsed of tabular.rows) {
      const values = parsed.values;
      const originalLinkContent =
        parsed.rawValues?.noteUrl || values.noteUrl || "";
      const hyperlinkTarget = parsed.hyperlinks?.noteUrl || "";
      const declaredChannel = (values.contentChannel || "").trim();
      const linkResolution = resolveImportedNoteLink({
        rawContent: originalLinkContent,
        hyperlinkTarget,
        declaredChannel,
      });
      const checked: CheckedRow = {
        rowNumber: parsed.rowNumber,
        url: linkResolution.url,
        originalLinkContent: linkResolution.originalContent,
        importedPlatform: values.platform || "",
        shopName: values.shopName || "",
        customerName: values.customerName || "",
        contentChannel: declaredChannel,
        orderNumber: values.orderNumber || "",
        publishTime: values.publishTime || "",
        platform: linkResolution.platform,
        recognitionStatus: linkResolution.status,
        failureReason: linkResolution.failureReason,
        productCode: values.productCode || "",
        productName: values.productName || "",
        campaignName: values.activityName || "",
        month: values.activityMonth || "",
        specification: values.specification || "",
        stageInput: values.productStage || "",
        productStage: "",
        stageGroup: "",
        notes: buildImportedTaskNotes({
          platform: values.platform,
          shopName: values.shopName,
          customerName: values.customerName,
          orderNumber: values.orderNumber,
          contentChannel: values.contentChannel,
          publishTime: values.publishTime,
          notes: values.remark,
        }),
        errors: [...parsed.errors],
      };
      if (hasContentChannelColumn && !declaredChannel) {
        checked.errors.push("内容渠道不能为空");
      }
      if (checked.failureReason) {
        checked.errors.push(checked.failureReason);
      }
      let normalizedUrl = "";
      if (checked.url && checked.recognitionStatus === "RECOGNIZED") {
        normalizedUrl = normalizeUrl(checked.url);
        const identity = auditNoteIdentity(checked.url);
        if (seen.has(identity)) checked.errors.push("文件内存在重复链接");
        seen.add(identity);
      }
      const productResolution = resolveProductReference(activeProducts, {
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
      }

      const campaign = product
        ? await prisma.campaign.findFirst({
            where: {
              ...(checked.campaignName
                ? { name: checked.campaignName }
                : {}),
              ...(checked.month ? { month: checked.month } : {}),
              status: "ACTIVE",
              OR: [
                { productId: product.id },
                { products: { some: { productId: product.id } } },
              ],
            },
            orderBy: [{ endDate: "desc" }, { updatedAt: "desc" }],
          })
        : null;
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
      if (!importedStage) {
        checked.errors.push("产品阶段话题请填写 IFFO 或 GUM。");
      }
      const stageRules = campaign
        ? await prisma.topicRule.findMany({
            where: {
              campaignId: campaign.id,
              topicCategory: "PRODUCT_STAGE",
              status: "ACTIVE",
            },
            select: { applicableStage: true, milkType: true },
          })
        : [];
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
      if (normalizedUrl && campaign?.id) {
        const duplicate = await findBlockingAuditTask({ url: checked.url });
        if (duplicate) {
          checked.errors.push(importedAuditTaskDuplicateMessage);
        }
      }
      checked.errors = [...new Set(checked.errors)];
      rows.push(checked);
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
      const committed = await prisma.$transaction(async (tx) => {
        const tasks: AutomaticTaskInput[] = validRows.map((row) => ({
          url: row.url,
          originalInput: row.originalLinkContent,
          productId: row.productId!,
          campaignId: row.campaignId!,
          productStage: row.productStage,
          milkType: row.milkType,
          source: sourceType.includes("TENCENT") ? "EXCEL" : "EXCEL",
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
      });
      batchId = committed.id;
      imported = validRows.length;
      kickAutomaticAuditQueue();
    }

    return ok({
      ...tabular,
      validCount: validRows.length,
      invalidCount: rows.length - validRows.length,
      imported,
      batchId,
      skipDuplicates,
      rows,
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "无法读取表格",
    );
  }
}

import { prisma } from "@/lib/db";
import { isSupportedNoteUrl, normalizeUrl } from "@/lib/topic";
import { fail, ok, requireApiUser } from "@/lib/api";
import {
  createAutomaticBatchInTransaction,
  type AutomaticTaskInput,
} from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import {
  detectProductStage,
  normalizeProductStageTopicValue,
  resolveConfiguredProductStage,
} from "@/lib/product-stage";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  detectLocalSourceType,
  parseTabularPreview,
} from "@/lib/import-export-templates/tabular";

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

    for (const parsed of tabular.rows) {
      const values = parsed.values;
      const checked: CheckedRow = {
        rowNumber: parsed.rowNumber,
        url: values.noteUrl || "",
        productCode: values.productCode || "",
        productName: values.productName || "",
        campaignName: values.activityName || "",
        month: values.activityMonth || "",
        specification: values.specification || "",
        stageInput: values.productStage || "",
        productStage: "",
        stageGroup: "",
        notes: values.remark || "",
        errors: [...parsed.errors],
      };
      if (!checked.url) {
        checked.errors.push("缺少必填字段：笔记链接");
      } else if (!isSupportedNoteUrl(checked.url)) {
        checked.errors.push("笔记链接格式不正确");
      }
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
            ...(checked.productName
              ? [
                  { name: checked.productName },
                  { aliases: { some: { alias: checked.productName } } },
                ]
              : []),
          ],
        },
      });
      if (!product) checked.errors.push("产品不存在或名称/别名未匹配");
      else checked.productId = product.id;

      const campaign = product
        ? await prisma.campaign.findFirst({
            where: {
              name: checked.campaignName,
              ...(checked.month ? { month: checked.month } : {}),
              status: "ACTIVE",
              OR: [
                { productId: product.id },
                { products: { some: { productId: product.id } } },
              ],
            },
          })
        : null;
      if (!campaign) {
        checked.errors.push("活动不存在或与产品不匹配");
      } else {
        checked.campaignId = campaign.id;
        checked.month = campaign.month;
      }

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
            select: { applicableStage: true, milkType: true },
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
        checked.errors.push("段位未识别：请填写产品规格、段位或产品阶段话题");
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
        if (existing?.auditResults.length) {
          checked.errors.push("同一链接已完成审核");
        } else if (existing) {
          checked.errors.push("同一链接已有待审核任务");
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

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
  campaignUsesDetailedProductStages,
  compatibleStageRuleValues,
  detailedProductStageLabel,
  detailedProductStagePhase,
  normalizeDetailedProductStageValue,
  normalizeImportedProductStageTopicValue,
  productStageTopicLabel,
} from "@/lib/product-stage";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  detectLocalSourceType,
  parseTabularPreview,
} from "@/lib/import-export-templates/tabular";
import { selectImportPreviewRows } from "@/lib/import-preview";
import {
  inferDanoneAgencyProductStage,
} from "@/lib/import-template-type";
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
import {
  resolveImportedActivity,
  type ImportActivityMatchStatus,
} from "@/lib/import-activity-matching";
import {
  commercePlatformLabel,
  contentChannelLabel,
} from "@/lib/result-source";
import {
  resolveStoreTopicConfig,
  type StoreMappingStatus,
} from "@/lib/store-topic-config";
import { loadActiveStoreTopicRules } from "@/lib/store-topic-rule-service";

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
  channel: NoteLinkPlatform;
  commercePlatform: string;
  expectedStoreTopic: string;
  expectedStoreTopics: string[];
  requiredStoreTopics: string[];
  storeTopicRuleId: string;
  matchedStoreName: string;
  storeMappingStatus: StoreMappingStatus;
  recognitionStatus: "RECOGNIZED" | "UNRECOGNIZED" | "UNSUPPORTED";
  failureReason: string;
  productCode: string;
  productName: string;
  purchaseProductLine: string;
  campaignName: string;
  importedCampaignName: string;
  campaignMatchStatus: ImportActivityMatchStatus;
  campaignPeriod: string;
  campaignRuleCount: number;
  month: string;
  specification: string;
  stageInput: string;
  stageDetailInput: string;
  productStage: string;
  stageGroup: string;
  notes: string;
  productId?: string;
  campaignId?: string;
  milkType?: string;
  errors: string[];
}

const IMPORT_PREVIEW_ROW_LIMIT = 100;

function dateLabel(value: Date) {
  return value.toISOString().slice(0, 10);
}

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
    return fail("请选择 Excel（.xlsx）表格文件");
  }
  if (!file.name.toLocaleLowerCase().endsWith(".xlsx")) {
    return fail("暂不支持CSV文件，请下载最新版Excel导入模板后重新填写。");
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
    const isDanoneAgencyTemplate = tabular.templateType === "DANONE_AGENCY";
    const activeProducts = await prisma.product.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      include: { aliases: { select: { alias: true } } },
    });
    const activeStoreTopicRules = await loadActiveStoreTopicRules();
    const campaignCandidates = (await prisma.campaign.findMany({
      include: {
        products: { select: { productId: true } },
        topicRules: { where: { status: "ACTIVE" }, select: { contentChannel: true } },
      },
    })).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      month: campaign.month,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      status: campaign.status,
      deletedAt: campaign.deletedAt,
      productId: campaign.productId,
      productIds: campaign.products.map((item) => item.productId),
      contentChannel: campaign.contentChannel,
      ruleChannels: campaign.topicRules.map((rule) => rule.contentChannel),
    }));
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
      const declaredChannel = String(
        (isKabritaTemplate
          ? ""
          : values.contentChannel || values.channel) || "",
      ).trim();
      const importedStoreName = String(values.shopName || "").trim();
      const importedCommercePlatform = String(
        (isKabritaTemplate
          ? values.channel
          : values.commercePlatform || values.platform) || "",
      ).trim();
      const storeResolution = resolveStoreTopicConfig(
        activeStoreTopicRules,
        {
          storeName: importedStoreName,
          commercePlatform: importedCommercePlatform,
        },
      );
      const purchaseProductLine = isKabritaTemplate
        ? values.purchaseProductLine || ""
        : "";
      const agencyProductStage = isDanoneAgencyTemplate
        ? inferDanoneAgencyProductStage(values.productName)
        : null;
      const linkResolution = resolveImportedNoteLink({
        rawContent: originalLinkContent,
        hyperlinkTarget,
        declaredChannel,
      });
      const checked: CheckedRow = {
        rowNumber: parsed.rowNumber,
        url: linkResolution.url,
        originalLinkContent: linkResolution.originalContent,
        importedPlatform:
          storeResolution.commercePlatform
            ? commercePlatformLabel(storeResolution.commercePlatform)
            : importedCommercePlatform,
        shopName: importedStoreName,
        customerName: isKabritaTemplate
          ? values.customerRemark || ""
          : values.customerName || "",
        contentChannel: contentChannelLabel(linkResolution.platform),
        orderNumber: isKabritaTemplate
          ? values.purchaseOrderNumber || ""
          : values.orderNumber || "",
        publishTime: isKabritaTemplate ? "" : values.publishTime || "",
        platform: linkResolution.platform,
        channel: linkResolution.platform,
        commercePlatform: storeResolution.commercePlatform || "",
        expectedStoreTopic: storeResolution.expectedTopic || "",
        expectedStoreTopics: storeResolution.expectedTopics,
        requiredStoreTopics: storeResolution.requiredTopics,
        storeTopicRuleId: storeResolution.storeTopicRuleId || "",
        matchedStoreName: storeResolution.matchedStoreName || "",
        storeMappingStatus: storeResolution.status,
        recognitionStatus: linkResolution.status,
        failureReason: linkResolution.failureReason,
        productCode: values.productCode || "",
        productName: isKabritaTemplate
          ? purchaseProductLine
          : values.productName || "",
        purchaseProductLine,
        campaignName: "",
        importedCampaignName: String(values.activityName || "").trim(),
        campaignMatchStatus: "EMPTY",
        campaignPeriod: "",
        campaignRuleCount: 0,
        month: "",
        specification: values.specification || "",
        stageInput: isKabritaTemplate
          ? inferKabritaProductStage(purchaseProductLine)
          : values.productStage || "",
        stageDetailInput: isKabritaTemplate
          ? ""
          : isDanoneAgencyTemplate
            ? agencyProductStage?.inferredStage || ""
            : values.productStageDetail || "",
        productStage: "",
        stageGroup: "",
        notes: buildImportedTaskNotes({
          platform:
            storeResolution.commercePlatform
              ? commercePlatformLabel(storeResolution.commercePlatform)
              : importedCommercePlatform,
          shopName: values.shopName,
          customerName: isKabritaTemplate
            ? values.customerRemark
            : values.customerName,
          orderNumber: isKabritaTemplate
            ? values.purchaseOrderNumber
            : values.orderNumber,
          contentChannel: contentChannelLabel(linkResolution.platform),
          publishTime: isKabritaTemplate ? undefined : values.publishTime,
          activityName: values.activityName,
          notes: values.remark,
          templateMetadata: {
            templateType: tabular.templateType,
            ...(isKabritaTemplate
              ? { templateBrand: KABRITA_BRAND_NAME }
              : {}),
            rawValues: isKabritaTemplate
              ? kabritaRawValues(parsed.rawValues || values)
              : parsed.rawValues || values,
          },
        }),
        errors: [...parsed.errors],
      };
      if (
        checked.channel !== "DOUYIN" &&
        storeResolution.status !== "MATCHED"
      ) {
        checked.errors.push(
          `${storeResolution.status}：${storeResolution.failureReason}`,
        );
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
        name:
          agencyProductStage?.normalizedProductName || checked.productName,
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

      const campaignResolution = resolveImportedActivity({
        activityName: checked.importedCampaignName,
        productId: product?.id,
        candidates: campaignCandidates.map((candidate) => ({
          ...candidate,
          ruleCount: [checked.channel, "ALL"].includes(candidate.contentChannel)
            ? candidate.ruleChannels.filter((channel) => [checked.channel, "ALL"].includes(channel)).length
            : 0,
        })),
        allowMissingRules: checked.channel === "DOUYIN",
      });
      checked.campaignMatchStatus = campaignResolution.status;
      const campaign = campaignResolution.campaign;
      if (campaignResolution.error) {
        checked.errors.push(campaignResolution.error);
      }
      if (campaign) {
        checked.campaignName = campaign.name;
        checked.month = campaign.month;
        checked.campaignPeriod = `${dateLabel(campaign.startDate)} 至 ${dateLabel(campaign.endDate)}`;
        checked.campaignRuleCount = campaign.ruleCount;
      }
      if (campaignResolution.status === "MATCHED" && campaign) {
        checked.campaignId = campaign.id;
      }

      const usesDetailedProductStages = Boolean(
        !isKabritaTemplate &&
        (isDanoneAgencyTemplate
          ? agencyProductStage?.inferredStage
          : tabular.templateType === "DANONE_CUSTOMER" ||
            (campaign && product && campaignUsesDetailedProductStages(
              product.brandName,
              campaign.month,
            ))),
      );
      const importedPhase = normalizeImportedProductStageTopicValue(
        checked.stageInput,
      );
      const importedDetailedStage = usesDetailedProductStages
        ? normalizeDetailedProductStageValue(checked.stageDetailInput)
        : null;
      const importedStage = usesDetailedProductStages
        ? importedDetailedStage
        : importedPhase;
      checked.productStage = importedStage || "";
      checked.stageGroup = importedStage
        ? (usesDetailedProductStages
            ? detailedProductStageLabel(importedStage)
            : productStageTopicLabel(importedStage))
        : "";
      if (!isKabritaTemplate && !checked.stageInput.trim()) {
        checked.errors.push("段位不能为空");
      } else if (!isKabritaTemplate && !importedPhase) {
        checked.errors.push("段位仅支持 IFFO 或 GUM");
      }
      if (
        tabular.templateType === "DANONE_CUSTOMER" &&
        !checked.stageDetailInput.trim()
      ) {
        checked.errors.push("阶段不能为空");
      } else if (
        tabular.templateType === "DANONE_CUSTOMER" &&
        !importedDetailedStage
      ) {
        checked.errors.push("阶段仅支持 P段、1段、2段、3段、4段、1+或2+");
      }
      if (
        importedPhase &&
        importedDetailedStage &&
        detailedProductStagePhase(importedDetailedStage) !== importedPhase
      ) {
        checked.errors.push(
          isDanoneAgencyTemplate && agencyProductStage?.inferredStage
            ? `产品段数与段位不匹配，${agencyProductStage.inferredStage}应属于${agencyProductStage.inferredGroup}`
            : "阶段与段位不匹配",
        );
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
            contentChannel: { in: [checked.channel, "ALL"] },
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
      if (
        stageRule?.milkType &&
        importedPhase &&
        stageRule.milkType !== importedPhase
      ) {
        checked.errors.push(
          `阶段与段位不一致：${importedPhase} 与 ${checked.stageGroup} 冲突`,
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
    let batchIds: string[] = [];
    let importRecordId: string | null = null;
    let importedAt: Date | null = null;
    if (commit) {
      const channelDistribution = Object.fromEntries(
        (["XIAOHONGSHU", "DOUYIN"] as const).map((channel) => [
          channel,
          validRows.filter((row) => row.channel === channel).length,
        ]),
      );
      const syncState = await prisma.ruleSyncState.findUnique({
        where: { id: "active" },
        select: { currentVersion: true },
      });
      const committed = await prisma.$transaction(
        async (tx) => {
          const skippedCount = skipDuplicates
            ? rows.filter((row) =>
                row.errors.includes(importedAuditTaskDuplicateMessage),
              ).length
            : 0;
          const importRecord = await tx.importRecord.create({
            data: {
              fileName: file.name,
              importType: "AUDIT_TASK",
              totalCount: rows.length,
              validCount: validRows.length,
              invalidCount: Math.max(
                0,
                rows.length - validRows.length - skippedCount,
              ),
              skippedCount,
              status: "COMPLETED",
              channelDistribution: JSON.stringify(channelDistribution),
              summary: JSON.stringify({
                templateVersion: tabular.templateVersion,
                templateBrand: tabular.templateBrand,
                templateType: tabular.templateType,
                sourceType,
                activities: [...new Map(validRows.map((row) => [
                  `${row.campaignId}\u0000${row.importedCampaignName}`,
                  {
                    activityId: row.campaignId,
                    importedName: row.importedCampaignName,
                    officialName: row.campaignName,
                    month: row.month,
                    period: row.campaignPeriod,
                    ruleCount: row.campaignRuleCount,
                  },
                ])).values()],
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
          const tasks: AutomaticTaskInput[] = validRows.map((row) => ({
            importRecordId: importRecord.id,
            url: row.url,
            originalInput: row.originalLinkContent,
            productId: row.productId!,
            campaignId: row.campaignId!,
            productStage: row.productStage,
            milkType: row.milkType,
            source: "EXCEL",
            notes: row.notes,
            platform: row.platform,
            channel: row.channel,
            commercePlatform: row.commercePlatform,
            storeName: row.shopName,
            storeTopicRuleId: row.storeTopicRuleId,
            matchedStoreName: row.matchedStoreName,
            expectedStoreTopic: row.expectedStoreTopic,
            expectedStoreTopics: row.expectedStoreTopics,
            requiredStoreTopics: row.requiredStoreTopics,
            storeMappingStatus: row.storeMappingStatus,
            orderNumber: row.orderNumber,
          }));
          const lastQueueOrder = (
            await tx.auditBatch.aggregate({ _max: { queueOrder: true } })
          )._max.queueOrder;
          const baseQueueOrder = (lastQueueOrder ?? -1) + 1;
          const batches = [];
          for (const [queueOrder, channel] of (
            ["XIAOHONGSHU", "DOUYIN"] as const
          ).entries()) {
            const channelTasks = tasks.filter(
              (task) => task.channel === channel,
            );
            if (!channelTasks.length) continue;
            const channelProductIds = [
              ...new Set(channelTasks.map((task) => task.productId)),
            ];
            const channelCampaignIds = [
              ...new Set(channelTasks.map((task) => task.campaignId)),
            ];
            batches.push(
              await createAutomaticBatchInTransaction(
                tx,
                {
                  name: `表格自动审核 · ${contentChannelLabel(channel)} · ${file.name}`,
                  importRecordId: importRecord.id,
                  source: "EXCEL",
                  createdBy: user.id,
                  productId:
                    channelProductIds.length === 1
                      ? channelProductIds[0]
                      : undefined,
                  campaignId:
                    channelCampaignIds.length === 1
                      ? channelCampaignIds[0]
                      : undefined,
                  queueOrder: baseQueueOrder + queueOrder,
                  allowQueuedBehindActive: true,
                  tasks: channelTasks,
                },
                syncState?.currentVersion || null,
              ),
            );
          }
          return { batches, importRecord };
        },
        { timeout: 60_000 },
      );
      batchIds = committed.batches.map((batch) => batch.id);
      batchId = batchIds[0] || null;
      importRecordId = committed.importRecord.id;
      importedAt = committed.importRecord.createdAt;
      imported = validRows.length;
      if (committed.batches.length) kickAutomaticAuditQueue();
    }

    const previewSelection = selectImportPreviewRows(
      rows,
      IMPORT_PREVIEW_ROW_LIMIT,
    );

    return ok({
      ...tabular,
      missingRequiredFields: tabular.missingRequiredFields.map(
        (field) => templates.fieldDefinitions[field].displayName,
      ),
      validCount: validRows.length,
      invalidCount: rows.length - validRows.length,
      imported,
      batchId,
      batchIds,
      auditBatchId: batchId,
      importRecordId,
      fileName: file.name,
      importedAt,
      importedCount: imported,
      channelDistribution: Object.fromEntries(
        (["XIAOHONGSHU", "DOUYIN"] as const).map((channel) => [
          channel,
          validRows.filter((row) => row.channel === channel).length,
        ]),
      ),
      plannedBatchCount: new Set(validRows.map((row) => row.channel)).size,
      skipDuplicates,
      ...previewSelection,
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "无法读取表格",
    );
  }
}

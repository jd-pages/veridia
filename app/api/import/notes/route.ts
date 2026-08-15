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
  type TabularParsePerformance,
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
  findAuditTaskDuplicateHistories,
  type AuditDuplicateHistoryEntry,
} from "@/lib/audit-task-deduplication";
import {
  normalizeProductMatchKey,
  productResolutionError,
  resolveProductReference,
  type ProductResolution,
} from "@/lib/product-matching";
import {
  buildImportedTaskNotes,
  duplicateReauditMetadataFromNotes,
  withDuplicateReauditMetadata,
} from "@/lib/import-task-metadata";
import {
  resolveImportedActivity,
  type ImportActivityMatchStatus,
} from "@/lib/import-activity-matching";
import {
  commercePlatformLabel,
  contentChannelLabel,
} from "@/lib/result-source";
import {
  normalizeStoreNameForMatch,
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
  duplicateWarning?: {
    status: "DUPLICATE_WARNING";
    identity: string;
    batchDuplicateOfRow: number | null;
    historicalCount: number;
    sourceTaskIds: string[];
    latestHistory: AuditDuplicateHistoryEntry | null;
    confirmed: boolean;
  };
  hasPreviewAttention?: boolean;
}

const IMPORT_PREVIEW_ROW_LIMIT = 100;

interface SlowPrecheckRow {
  rowNumber: number;
  totalMs: number;
  slowestStage: string;
  slowestStageMs: number;
}

interface PrecheckPerformance {
  startedAt: number;
  formDataMs: number;
  fileReadMs: number;
  excelParseMs: number;
  worksheetParseMs: number;
  headerRecognitionMs: number;
  rowConversionMs: number;
  productMatchMs: number;
  activityMatchMs: number;
  ruleMatchMs: number;
  urlMs: number;
  databaseMs: number;
  dbQueryCount: number;
  browserMs: number;
  networkMs: number;
  rowValidationMs: number;
  worksheetRowCount: number;
  effectiveWorksheetRowCount: number;
  effectiveWorksheetColumnCount: number;
  slowestRows: SlowPrecheckRow[];
  dbBreakdown: Record<string, number>;
}

function roundedMs(value: number) {
  return Math.round(value * 100) / 100;
}

function logPrecheckPerformance(
  metrics: PrecheckPerformance,
  rowCount: number,
  outcome: "PASSED" | "FAILED",
) {
  const totalMs = performance.now() - metrics.startedAt;
  console.info(
    [
      "[PRECHECK_PERF]",
      `outcome=${outcome}`,
      `formDataMs=${roundedMs(metrics.formDataMs)}`,
      `fileReadMs=${roundedMs(metrics.fileReadMs)}`,
      `excelParseMs=${roundedMs(metrics.excelParseMs)}`,
      `worksheetParseMs=${roundedMs(metrics.worksheetParseMs)}`,
      `headerRecognitionMs=${roundedMs(metrics.headerRecognitionMs)}`,
      `rowConversionMs=${roundedMs(metrics.rowConversionMs)}`,
      `rowCount=${rowCount}`,
      `dbQueryCount=${metrics.dbQueryCount}`,
      `dbMs=${roundedMs(metrics.databaseMs)}`,
      `ruleMatchMs=${roundedMs(metrics.ruleMatchMs)}`,
      `productMatchMs=${roundedMs(metrics.productMatchMs)}`,
      `activityMatchMs=${roundedMs(metrics.activityMatchMs)}`,
      `urlMs=${roundedMs(metrics.urlMs)}`,
      `browserMs=${metrics.browserMs}`,
      `networkMs=${metrics.networkMs}`,
      `rowValidationMs=${roundedMs(metrics.rowValidationMs)}`,
      `worksheetRows=${metrics.worksheetRowCount}`,
      `effectiveWorksheetRows=${metrics.effectiveWorksheetRowCount}`,
      `effectiveWorksheetColumns=${metrics.effectiveWorksheetColumnCount}`,
      `totalMs=${roundedMs(totalMs)}`,
      `dbBreakdown=${JSON.stringify(metrics.dbBreakdown)}`,
      `slowestRows=${JSON.stringify(metrics.slowestRows)}`,
    ].join(" "),
  );
}

function dateLabel(value: Date) {
  return value.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const perf: PrecheckPerformance = {
    startedAt: performance.now(),
    formDataMs: 0,
    fileReadMs: 0,
    excelParseMs: 0,
    worksheetParseMs: 0,
    headerRecognitionMs: 0,
    rowConversionMs: 0,
    productMatchMs: 0,
    activityMatchMs: 0,
    ruleMatchMs: 0,
    urlMs: 0,
    databaseMs: 0,
    dbQueryCount: 0,
    browserMs: 0,
    networkMs: 0,
    rowValidationMs: 0,
    worksheetRowCount: 0,
    effectiveWorksheetRowCount: 0,
    effectiveWorksheetColumnCount: 0,
    slowestRows: [],
    dbBreakdown: {},
  };
  let measuredRowCount = 0;
  let performanceLogged = false;
  const measureDatabase = async <T>(label: string, operation: () => Promise<T>) => {
    const started = performance.now();
    perf.dbQueryCount += 1;
    try {
      return await operation();
    } finally {
      const elapsed = performance.now() - started;
      perf.databaseMs += elapsed;
      perf.dbBreakdown[label] = roundedMs(
        (perf.dbBreakdown[label] || 0) + elapsed,
      );
    }
  };
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const formDataStarted = performance.now();
  const form = await request.formData();
  perf.formDataMs = performance.now() - formDataStarted;
  const file = form.get("file");
  const commit = form.get("commit") === "true";
  const skipDuplicates = form.get("skipDuplicates") !== "false";
  const duplicateOverrideKeys = new Set<string>();
  try {
    const raw = String(form.get("duplicateOverrides") || "[]");
    const parsed = JSON.parse(raw) as Array<{
      rowNumber?: unknown;
      identity?: unknown;
    }>;
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const rowNumber = Number(item.rowNumber);
      const identity = String(item.identity || "").trim();
      if (Number.isInteger(rowNumber) && rowNumber > 0 && identity) {
        duplicateOverrideKeys.add(`${rowNumber}\u0000${identity}`);
      }
    }
  } catch {
    return fail("重复重审确认信息格式不正确");
  }
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
    const fileReadStarted = performance.now();
    const [templateState, fileBuffer] = await Promise.all([
      measureDatabase("templateConfig", () => getActiveImportExportTemplates()),
      file.arrayBuffer().finally(() => {
        perf.fileReadMs = performance.now() - fileReadStarted;
      }),
    ]);
    const { templates } = templateState;
    const sourceType = detectLocalSourceType(file.name, declaredTencentExport);
    let tabularPerformance: TabularParsePerformance | undefined;
    const [tabular, activeProducts, activeStoreTopicRules, rawCampaigns] =
      await Promise.all([
        parseTabularPreview({
          bytes: new Uint8Array(fileBuffer),
          fileName: file.name,
          sourceType,
          templates,
          onPerformance: (measurement) => {
            tabularPerformance = measurement;
          },
        }),
        measureDatabase("products", () =>
          prisma.product.findMany({
            where: { status: "ACTIVE", deletedAt: null },
            include: { aliases: { select: { alias: true } } },
          }),
        ),
        measureDatabase("storeTopicRules", () => loadActiveStoreTopicRules()),
        measureDatabase("campaigns", () =>
          prisma.campaign.findMany({
            include: {
              products: { select: { productId: true } },
              topicRules: {
                where: { status: "ACTIVE" },
                select: { contentChannel: true },
              },
            },
          }),
        ),
      ]);
    if (tabularPerformance) {
      perf.excelParseMs = tabularPerformance.excelParseMs;
      perf.worksheetParseMs = tabularPerformance.worksheetParseMs;
      perf.headerRecognitionMs = tabularPerformance.headerRecognitionMs;
      perf.rowConversionMs = tabularPerformance.rowConversionMs;
      perf.worksheetRowCount = tabularPerformance.worksheetRowCount;
      perf.effectiveWorksheetRowCount =
        tabularPerformance.effectiveWorksheetRowCount;
      perf.effectiveWorksheetColumnCount =
        tabularPerformance.effectiveWorksheetColumnCount;
    }
    measuredRowCount = tabular.rows.length;
    const rows: CheckedRow[] = [];
    const seen = new Map<string, number>();
    const isKabritaTemplate = tabular.templateBrand === KABRITA_BRAND_NAME;
    const isDanoneAgencyTemplate = tabular.templateType === "DANONE_AGENCY";
    const campaignCandidates = rawCampaigns.map((campaign) => ({
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
      ruleCount: campaign.topicRules.filter((rule) =>
        [campaign.contentChannel, "ALL"].includes(rule.contentChannel),
      ).length,
    }));
    const allStageRules = campaignCandidates.length
      ? await measureDatabase("stageRules", () =>
          prisma.topicRule.findMany({
            where: {
              campaignId: { in: campaignCandidates.map((campaign) => campaign.id) },
              topicCategory: "PRODUCT_STAGE",
              status: "ACTIVE",
            },
            select: {
              brandName: true,
              campaignId: true,
              productId: true,
              contentChannel: true,
              applicableStage: true,
              milkType: true,
            },
          }),
        )
      : [];
    const stageRulesCache = new Map<
      string,
      Array<{ applicableStage: string | null; milkType: string | null }>
    >();
    const matchingProducts = isKabritaTemplate
      ? activeProducts.filter(
          (product) => product.brandName.trim() === KABRITA_BRAND_NAME,
        )
      : activeProducts;
    const productResolutionCache = new Map<
      string,
      ProductResolution<(typeof activeProducts)[number]>
    >();
    const storeResolutionCache = new Map<
      string,
      ReturnType<typeof resolveStoreTopicConfig>
    >();
    const campaignResolutionCache = new Map<
      string,
      ReturnType<typeof resolveImportedActivity>
    >();

    for (const parsed of tabular.rows) {
      const rowStarted = performance.now();
      const rowStages: Record<string, number> = {};
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
      const storeMatchStarted = performance.now();
      const storeResolutionKey = [
        importedCommercePlatform,
        normalizeStoreNameForMatch(importedStoreName),
      ].join("\u0000");
      let storeResolution = storeResolutionCache.get(storeResolutionKey);
      if (!storeResolution) {
        storeResolution = resolveStoreTopicConfig(activeStoreTopicRules, {
          storeName: importedStoreName,
          commercePlatform: importedCommercePlatform,
        });
        storeResolutionCache.set(storeResolutionKey, storeResolution);
      }
      rowStages.storeMatchMs = performance.now() - storeMatchStarted;
      perf.ruleMatchMs += rowStages.storeMatchMs;
      const purchaseProductLine = isKabritaTemplate
        ? values.purchaseProductLine || ""
        : "";
      const agencyProductStage = isDanoneAgencyTemplate
        ? inferDanoneAgencyProductStage(values.productName)
        : null;
      const urlStarted = performance.now();
      const linkResolution = resolveImportedNoteLink({
        rawContent: originalLinkContent,
        hyperlinkTarget,
        declaredChannel,
      });
      rowStages.urlMs = performance.now() - urlStarted;
      perf.urlMs += rowStages.urlMs;
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
        const firstRow = seen.get(identity);
        if (firstRow) {
          checked.duplicateWarning = {
            status: "DUPLICATE_WARNING",
            identity,
            batchDuplicateOfRow: firstRow,
            historicalCount: 0,
            sourceTaskIds: [],
            latestHistory: null,
            confirmed: false,
          };
        } else {
          seen.set(identity, checked.rowNumber);
        }
      }
      const productMatchStarted = performance.now();
      const productInputName =
        agencyProductStage?.normalizedProductName || checked.productName;
      const productResolutionKey = [
        normalizeProductMatchKey(checked.productCode),
        normalizeProductMatchKey(productInputName),
      ].join("\u0000");
      let productResolution = productResolutionCache.get(productResolutionKey);
      if (!productResolution) {
        productResolution = resolveProductReference(matchingProducts, {
          code: checked.productCode,
          name: productInputName,
        });
        productResolutionCache.set(productResolutionKey, productResolution);
      }
      rowStages.productMatchMs = performance.now() - productMatchStarted;
      perf.productMatchMs += rowStages.productMatchMs;
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

      const activityMatchStarted = performance.now();
      const activityChannel = checked.channel === "DOUYIN"
        ? "DOUYIN"
        : "XIAOHONGSHU";
      const campaignResolutionKey = [
        checked.importedCampaignName,
        product?.id || "",
        activityChannel,
      ].join("\u0000");
      let campaignResolution = campaignResolutionCache.get(
        campaignResolutionKey,
      );
      if (!campaignResolution) {
        campaignResolution = resolveImportedActivity({
          activityName: checked.importedCampaignName,
          productId: product?.id,
          contentChannel: activityChannel,
          candidates: campaignCandidates,
        });
        campaignResolutionCache.set(
          campaignResolutionKey,
          campaignResolution,
        );
      }
      rowStages.activityMatchMs = performance.now() - activityMatchStarted;
      perf.activityMatchMs += rowStages.activityMatchMs;
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

      const ruleMatchStarted = performance.now();
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
      const stageRulesKey = campaign && product
        ? `${campaign.id}\u0000${product.id}\u0000${checked.channel}`
        : "";
      let matchingStageRules = stageRulesCache.get(stageRulesKey) || [];
      if (
        campaign &&
        product?.brandName.trim() &&
        !stageRulesCache.has(stageRulesKey)
      ) {
        matchingStageRules = allStageRules.filter(
          (rule) =>
            rule.brandName === product.brandName &&
            rule.campaignId === campaign.id &&
            (rule.productId === null || rule.productId === product.id) &&
            [checked.channel, "ALL"].includes(rule.contentChannel),
        );
        stageRulesCache.set(stageRulesKey, matchingStageRules);
      }
      const compatibleStages = compatibleStageRuleValues(importedStage);
      const stageRule = importedStage
        ? matchingStageRules.find(
            (rule) => compatibleStages.includes(rule.applicableStage || ""),
          )
        : null;
      if (importedStage && !stageRule && campaign && product) {
        checked.errors.push(
          `第${checked.rowNumber}行：当前活动要求阶段话题，但产品‘${product.name}’的 ${checked.stageGroup || productStageTopicLabel(importedStage)} 阶段未配置可用话题规则。`,
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
      rowStages.stageRuleMatchMs = performance.now() - ruleMatchStarted;
      perf.ruleMatchMs += rowStages.stageRuleMatchMs;
      checked.errors = [...new Set(checked.errors)];
      rows.push(checked);
      const rowTotalMs = performance.now() - rowStarted;
      perf.rowValidationMs += rowTotalMs;
      const [slowestStage, slowestStageMs] = Object.entries(rowStages).reduce(
        (slowest, current) => current[1] > slowest[1] ? current : slowest,
        ["rowSetupMs", 0] as [string, number],
      );
      perf.slowestRows.push({
        rowNumber: parsed.rowNumber,
        totalMs: roundedMs(rowTotalMs),
        slowestStage,
        slowestStageMs: roundedMs(slowestStageMs),
      });
      perf.slowestRows.sort((left, right) => right.totalMs - left.totalMs);
      if (perf.slowestRows.length > 10) perf.slowestRows.length = 10;
    }

    const duplicateCandidates = [
      ...new Set(
        rows
          .filter((row) => row.url)
          .map((row) => row.url),
      ),
    ];
    const duplicateHistories = duplicateCandidates.length
      ? await measureDatabase("duplicateTasks", () =>
          findAuditTaskDuplicateHistories({ urls: duplicateCandidates }),
        )
      : new Map<string, never>();
    for (const row of rows) {
      const history = duplicateHistories.get(row.url);
      if (history || row.duplicateWarning) {
        const identity = history?.identity || row.duplicateWarning!.identity;
        const confirmed = duplicateOverrideKeys.has(
          `${row.rowNumber}\u0000${identity}`,
        );
        row.duplicateWarning = {
          status: "DUPLICATE_WARNING",
          identity,
          batchDuplicateOfRow:
            row.duplicateWarning?.batchDuplicateOfRow || null,
          historicalCount: history?.historicalCount || 0,
          sourceTaskIds: history?.sourceTaskIds || [],
          latestHistory: history?.latest || null,
          confirmed,
        };
        row.hasPreviewAttention = !confirmed;
      }
    }

    const failedRows = rows.filter((row) => row.errors.length > 0);
    const duplicateRows = rows.filter((row) => row.duplicateWarning);
    const pendingDuplicateRows = duplicateRows.filter(
      (row) => !row.duplicateWarning?.confirmed,
    );
    const confirmedDuplicateRows = duplicateRows.filter(
      (row) => row.duplicateWarning?.confirmed && row.errors.length === 0,
    );
    const validRows = rows.filter(
      (row) =>
        row.errors.length === 0 &&
        (!row.duplicateWarning || row.duplicateWarning.confirmed),
    );
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
          const skippedCount = pendingDuplicateRows.length;
          const importRecord = await tx.importRecord.create({
            data: {
              fileName: file.name,
              importType: "AUDIT_TASK",
              totalCount: rows.length,
              validCount: validRows.length,
              invalidCount: failedRows.length,
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
            notes: row.duplicateWarning
              ? withDuplicateReauditMetadata(row.notes, {
                  identity: row.duplicateWarning.identity,
                  historicalCount: row.duplicateWarning.historicalCount,
                  confirmedAt: new Date().toISOString(),
                  confirmedByUserId: user.id,
                  confirmedByDisplayName: user.displayName,
                  sourceTaskIds: row.duplicateWarning.sourceTaskIds,
                })
              : row.notes,
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
            queueOrder: row.rowNumber,
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
          const duplicateReauditTasks = await tx.auditTask.findMany({
            where: { importRecordId: importRecord.id },
            select: { id: true, notes: true },
          });
          const duplicateLogs = duplicateReauditTasks.flatMap((task) => {
            const metadata = duplicateReauditMetadataFromNotes(task.notes);
            return metadata
              ? [{
                  userId: user.id,
                  action: "ALLOW_DUPLICATE_REAUDIT",
                  entityType: "AUDIT_TASK",
                  entityId: task.id,
                  summary: `允许重复笔记重新审核，历史 ${metadata.historicalCount} 次`,
                  metadata: JSON.stringify({
                    identity: metadata.identity,
                    historicalCount: metadata.historicalCount,
                    sourceTaskIds: metadata.sourceTaskIds,
                  }),
                }]
              : [];
          });
          if (duplicateLogs.length) {
            await tx.operationLog.createMany({ data: duplicateLogs });
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

    if (!commit) {
      logPrecheckPerformance(perf, rows.length, "PASSED");
      performanceLogged = true;
    }
    return ok({
      ...tabular,
      missingRequiredFields: tabular.missingRequiredFields.map(
        (field) => templates.fieldDefinitions[field].displayName,
      ),
      validCount: validRows.length,
      invalidCount: failedRows.length,
      duplicateWarningCount: duplicateRows.length,
      pendingDuplicateCount: pendingDuplicateRows.length,
      confirmedDuplicateCount: confirmedDuplicateRows.length,
      importableCount: validRows.length,
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
    if (!commit && !performanceLogged) {
      logPrecheckPerformance(perf, measuredRowCount, "FAILED");
    }
    return fail(
      error instanceof Error ? error.message : "无法读取表格",
    );
  }
}

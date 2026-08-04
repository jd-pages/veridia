import "server-only";
import ExcelJS from "exceljs";
import type { Worksheet } from "exceljs";
import { prisma } from "@/lib/db";
import { cellText } from "@/lib/excel";
import { normalizeTopic } from "@/lib/topic";
import { MIN_BODY_LENGTH } from "@/lib/audit-constants";
import {
  PRODUCT_STAGE_TOPIC_VALUES,
  detectProductStage,
  normalizeProductStageTopicValue,
} from "@/lib/product-stage";
import {
  PRODUCT_ALIAS_AMBIGUOUS_MESSAGE,
  PRODUCT_NOT_RECOGNIZED_MESSAGE,
  normalizeProductMatchKey,
  resolveProductReference,
} from "@/lib/product-matching";

export const PRODUCT_STAGES = PRODUCT_STAGE_TOPIC_VALUES;

export interface CampaignImportMetadata {
  campaignName: string;
  month: string;
  startDate: string;
  endDate: string;
}

export interface NormalizedProductRule {
  code: string | null;
  seriesName: string;
  name: string;
  aliases: string[];
  contentDirection: string;
}

export interface NormalizedTopicRule {
  productName: string | null;
  applicableStage: string | null;
  milkType: string | null;
  topic: string;
  ruleType: "REQUIRED" | "ANY" | "FORBIDDEN";
  topicCategory: "BRAND_COMMON" | "PRODUCT_COMMON" | "PRODUCT_STAGE";
  exactMatch: boolean;
  clickableRequired: boolean;
  minCount: number;
  sortOrder: number;
  status: "ACTIVE" | "INACTIVE";
}

export interface NormalizedCampaignRules {
  sourceFormat: "RAW_CAMPAIGN" | "STANDARD_TEMPLATE";
  campaign: {
    name: string;
    month: string;
    year: number;
    startDate: string;
    endDate: string;
    minImageCount: number;
    minBodyLength: number;
    publicRequired: boolean;
    retentionDays: number;
    rewardDescription: string;
    customerRegistrationNotes: string;
  };
  products: NormalizedProductRule[];
  topicRules: NormalizedTopicRule[];
  diagnostics: {
    unrecognizedCells: string[];
    missingProductNames: string[];
    missingStages: string[];
    duplicateTopics: string[];
    irregularTopics: string[];
    unrecognizedProductImages: string[];
    corrections: string[];
  };
}

function normalizeStage(value: string) {
  const text = value.trim();
  if (!text) return "";
  return (
    normalizeProductStageTopicValue(text) ||
    detectProductStage([text]).group ||
    ""
  );
}

function splitTopics(value: string) {
  return [...value.matchAll(/#[^#\s]+/gu)]
    .map((match) => normalizeTopic(match[0]))
    .filter(Boolean);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function resolveImportedProductName(
  products: NormalizedProductRule[],
  value: string,
) {
  const resolution = resolveProductReference(
    products.map((product, index) => ({
      ...product,
      id: `imported-product-${index}`,
    })),
    { name: value },
  );
  if (resolution.status === "AMBIGUOUS") {
    throw new Error(PRODUCT_ALIAS_AMBIGUOUS_MESSAGE);
  }
  if (resolution.status === "NOT_FOUND") {
    throw new Error(PRODUCT_NOT_RECOGNIZED_MESSAGE);
  }
  return resolution.product.name;
}

function inferSharedBrandName(products: NormalizedProductRule[]) {
  const names = products.map((product) => product.name.trim()).filter(Boolean);
  if (!names.length) return null;
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (prefix && !name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  if (prefix === "爱他美") return "达能";
  return prefix.length >= 2 ? prefix : null;
}

function findRow(sheet: Worksheet, label: string) {
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      if (cellText(sheet.getCell(row, col)).includes(label)) return row;
    }
  }
  return 0;
}

function findColumn(sheet: Worksheet, row: number, label: string) {
  const candidates: Array<{ col: number; value: string }> = [];
  for (let col = 1; col <= sheet.columnCount; col += 1) {
    const value = cellText(sheet.getCell(row, col));
    if (value.includes(label)) candidates.push({ col, value });
  }
  return (
    candidates.find((candidate) => candidate.value === label)?.col ||
    candidates.find((candidate) => candidate.value.startsWith(label))?.col ||
    candidates[0]?.col ||
    0
  );
}

function parseBoolean(value: string, fallback = false) {
  if (/^(是|true|yes|1)$/i.test(value.trim())) return true;
  if (/^(否|false|no|0)$/i.test(value.trim())) return false;
  return fallback;
}

function parseMinimumImageCount(value: string) {
  const explicit = value.match(
    /(?:≥|>=|至少|不少于|最低)\s*(\d+)\s*张/u,
  )?.[1];
  return Math.max(0, Number(explicit || 0));
}

function readHeaders(sheet: Worksheet) {
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => {
    const value = cellText(cell);
    if (value) headers.set(value, col);
  });
  return headers;
}

function valueAt(
  sheet: Worksheet,
  row: number,
  headers: Map<string, number>,
  name: string,
) {
  const column = headers.get(name);
  return column ? cellText(sheet.getCell(row, column)) : "";
}

function parseRawCampaign(
  workbook: ExcelJS.Workbook,
  metadata: CampaignImportMetadata,
): NormalizedCampaignRules {
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 中没有工作表");

  const imageText = cellText(sheet.getCell("B1"));
  const retentionText = cellText(sheet.getCell("B3"));
  const topicHeaderRow = findRow(sheet, "产品阶段话题");
  const contentStartRow = findRow(sheet, "内容参考方向");
  const rewardRow = findRow(sheet, "奖励");
  if (!topicHeaderRow || !contentStartRow || !rewardRow) {
    throw new Error("未识别到原始活动规则表的核心区域");
  }

  const commonTopicColumn = findColumn(sheet, topicHeaderRow, "通用话题");
  const stageStartColumn = findColumn(sheet, topicHeaderRow, "产品阶段话题");
  if (!commonTopicColumn || !stageStartColumn) {
    throw new Error("未识别到通用话题或产品阶段话题列");
  }
  const seriesNameColumn = Math.max(1, commonTopicColumn - 1);
  const stageHeaderRow = topicHeaderRow + 1;
  const productStartRow = stageHeaderRow + 1;
  const productEndRow = contentStartRow - 1;

  const rawProducts: Array<{
    row: number;
    seriesName: string;
    topics: string[];
  }> = [];
  for (let row = productStartRow; row <= productEndRow; row += 1) {
    const seriesName = cellText(sheet.getCell(row, seriesNameColumn));
    const topics = splitTopics(cellText(sheet.getCell(row, commonTopicColumn)));
    if (seriesName || topics.length) rawProducts.push({ row, seriesName, topics });
  }
  if (!rawProducts.length) throw new Error("未识别到产品系列");

  const frequency = new Map<string, number>();
  for (const product of rawProducts) {
    for (const topic of new Set(product.topics)) {
      frequency.set(topic, (frequency.get(topic) || 0) + 1);
    }
  }
  const brandTopics = [...frequency.entries()]
    .filter(([, count]) => count === rawProducts.length)
    .map(([topic]) => topic);

  const corrections: string[] = [];
  const products: NormalizedProductRule[] = rawProducts.map((product, index) => {
    const productTopic =
      product.topics.find((topic) => !brandTopics.includes(topic)) ||
      product.topics[0] ||
      "";
    const name = productTopic.replace(/^#/, "") || product.seriesName;
    const directionCell = cellText(sheet.getCell(contentStartRow + index, 2));
    const directionLabel =
      directionCell.match(/^([^：:]+)[：:]/u)?.[1]?.trim() || "";
    let contentDirection = directionCell;
    const referencedProduct =
      contentDirection.match(/使用(爱他美.+?)后的/u)?.[1]?.trim() || "";
    const equivalentProductNames = new Set([
      name,
      name.replace(/版$/u, ""),
      name.replace(/5HMO$/iu, ""),
      `爱他美${product.seriesName}`,
    ]);
    if (
      name &&
      referencedProduct &&
      !equivalentProductNames.has(referencedProduct)
    ) {
      const corrected = contentDirection.replace(
        /使用爱他美.+?后的/u,
        `使用${name}后的`,
      );
      corrections.push(
        `${sheet.name}!B${contentStartRow + index}：已按相邻产品名称修正内容方向中的产品名`,
      );
      contentDirection = corrected;
    }
    const simplified = name
      .replace(/^爱他美/u, "")
      .replace(/版$/u, "");
    return {
      code: null,
      seriesName: name,
      name,
      aliases: unique([
        product.seriesName,
        simplified,
        directionLabel,
        name.replace(/^爱他美/u, ""),
      ]),
      contentDirection,
    };
  });

  const topicRules: NormalizedTopicRule[] = [];
  let sortOrder = 10;
  for (const topic of brandTopics) {
    topicRules.push({
      productName: null,
      applicableStage: null,
      milkType: null,
      topic,
      ruleType: "REQUIRED",
      topicCategory: "BRAND_COMMON",
      exactMatch: true,
      clickableRequired: true,
      minCount: 1,
      sortOrder,
      status: "ACTIVE",
    });
    sortOrder += 10;
  }
  for (const [index, product] of rawProducts.entries()) {
    for (const topic of product.topics.filter(
      (item) => !brandTopics.includes(item),
    )) {
      topicRules.push({
        productName: products[index].name,
        applicableStage: null,
        milkType: null,
        topic,
        ruleType: "REQUIRED",
        topicCategory: "PRODUCT_COMMON",
        exactMatch: true,
        clickableRequired: true,
        minCount: 1,
        sortOrder,
        status: "ACTIVE",
      });
      sortOrder += 10;
    }
  }

  const duplicateTopics: string[] = [];
  for (let col = stageStartColumn; col <= sheet.columnCount; col += 1) {
    const header = cellText(sheet.getCell(stageHeaderRow, col));
    const headerMatch = header.match(/^([^：:]+)[：:]\s*(.+)$/u);
    if (!headerMatch) continue;
    const milkType = headerMatch[1].trim().toUpperCase();
    const stageGroup =
      normalizeProductStageTopicValue(header) ||
      detectProductStage([headerMatch[2]]).group;
    const topics = unique(
      rawProducts.flatMap((product) =>
        splitTopics(cellText(sheet.getCell(product.row, col))),
      ),
    );
    if (topics.length === 1 && rawProducts.length > 1) {
      duplicateTopics.push(
        `${topics[0]} 在 ${rawProducts.length} 个产品行重复，已规范化为共享段位规则`,
      );
    }
    if (stageGroup) {
      for (const topic of topics) {
        topicRules.push({
          productName: null,
          applicableStage: stageGroup,
          milkType,
          topic,
          ruleType: "REQUIRED",
          topicCategory: "PRODUCT_STAGE",
          exactMatch: true,
          clickableRequired: true,
          minCount: 1,
          sortOrder,
          status: "ACTIVE",
        });
        sortOrder += 10;
      }
    }
  }
  for (const topic of brandTopics) {
    duplicateTopics.push(
      `${topic} 在 ${rawProducts.length} 个产品行重复，已规范化为品牌通用规则`,
    );
  }

  const retentionDays = Number(
    retentionText.match(/(?:保留|至少)[^\d]*(\d+)\s*天/u)?.[1] || 0,
  );
  const rewardDescription = unique([
    cellText(sheet.getCell(rewardRow, 2)),
    cellText(sheet.getCell(rewardRow, 3)),
  ]).join("；");
  const imageLocations = workbook.worksheets[0].getImages().map((image, index) => {
    const range = image.range as unknown as {
      tl?: { nativeRow?: number; nativeCol?: number };
    };
    const row = (range.tl?.nativeRow ?? productStartRow - 1) + 1;
    const col = (range.tl?.nativeCol ?? 1) + 1;
    return `图片${index + 1}（约位于第 ${row} 行、第 ${col} 列；无产品编码元数据，仅作版面参考）`;
  });

  return {
    sourceFormat: "RAW_CAMPAIGN",
    campaign: {
      name: metadata.campaignName,
      month: metadata.month,
      year: Number(metadata.month.slice(0, 4)),
      startDate: metadata.startDate,
      endDate: metadata.endDate,
      minImageCount: parseMinimumImageCount(imageText),
      minBodyLength: MIN_BODY_LENGTH,
      publicRequired: /公开状态/u.test(retentionText),
      retentionDays,
      rewardDescription,
      customerRegistrationNotes: imageText
        ? `图片数量由系统自动审核；图片内容与视觉要求由客服登记时人工检查：${imageText}`
        : "",
    },
    products,
    topicRules,
    diagnostics: {
      unrecognizedCells: [],
      missingProductNames: products
        .filter((product) => !product.name)
        .map((product) => product.seriesName || "未命名产品"),
      missingStages: PRODUCT_STAGES.filter(
        (stage) =>
          !topicRules.some(
            (rule) =>
              rule.topicCategory === "PRODUCT_STAGE" &&
              rule.applicableStage === stage,
          ),
      ),
      duplicateTopics,
      irregularTopics: topicRules
        .filter((rule) => !rule.topic.startsWith("#"))
        .map((rule) => rule.topic),
      unrecognizedProductImages: imageLocations,
      corrections,
    },
  };
}

function parseStandardTemplate(
  workbook: ExcelJS.Workbook,
): NormalizedCampaignRules {
  const campaignSheet = workbook.getWorksheet("活动基础规则");
  const productSheet = workbook.getWorksheet("产品资料");
  const topicSheet = workbook.getWorksheet("话题规则");
  const directionSheet = workbook.getWorksheet("内容参考方向");
  if (!campaignSheet || !productSheet || !topicSheet || !directionSheet) {
    throw new Error(
      "标准模板必须包含：活动基础规则、产品资料、话题规则、内容参考方向",
    );
  }

  const campaignHeaders = readHeaders(campaignSheet);
  const campaignValue = (name: string) =>
    valueAt(campaignSheet, 2, campaignHeaders, name);
  const name = campaignValue("活动名称");
  const month = campaignValue("活动月份");
  const productHeaders = readHeaders(productSheet);
  const products: NormalizedProductRule[] = [];
  for (let row = 2; row <= productSheet.rowCount; row += 1) {
    const productName = valueAt(productSheet, row, productHeaders, "产品名称");
    const seriesName = valueAt(productSheet, row, productHeaders, "产品系列");
    if (!productName && !seriesName) continue;
    products.push({
      code: valueAt(productSheet, row, productHeaders, "产品编码") || null,
      seriesName: seriesName || productName,
      name: productName,
      aliases: unique(
        valueAt(productSheet, row, productHeaders, "产品别名").split(/[、,，]/u),
      ),
      contentDirection: "",
    });
  }
  const directionHeaders = readHeaders(directionSheet);
  for (let row = 2; row <= directionSheet.rowCount; row += 1) {
    const importedProductName = valueAt(
      directionSheet,
      row,
      directionHeaders,
      "产品名称",
    );
    if (!importedProductName) continue;
    const productName = resolveImportedProductName(
      products,
      importedProductName,
    );
    const product = products.find((item) => item.name === productName);
    if (product) {
      product.contentDirection = valueAt(
        directionSheet,
        row,
        directionHeaders,
        "内容参考方向",
      );
    }
  }

  const policyMap: Record<string, NormalizedTopicRule["ruleType"]> = {
    必须全部包含: "REQUIRED",
    任意包含: "ANY",
    禁止出现: "FORBIDDEN",
    REQUIRED: "REQUIRED",
    ANY: "ANY",
    FORBIDDEN: "FORBIDDEN",
  };
  const categoryMap: Record<string, NormalizedTopicRule["topicCategory"]> = {
    品牌通用: "BRAND_COMMON",
    产品通用: "PRODUCT_COMMON",
    产品阶段话题: "PRODUCT_STAGE",
    产品段位话题: "PRODUCT_STAGE",
    BRAND_COMMON: "BRAND_COMMON",
    PRODUCT_COMMON: "PRODUCT_COMMON",
    PRODUCT_STAGE: "PRODUCT_STAGE",
  };
  const topicHeaders = readHeaders(topicSheet);
  const topicRules: NormalizedTopicRule[] = [];
  const irregularTopics: string[] = [];
  for (let row = 2; row <= topicSheet.rowCount; row += 1) {
    const rawTopic = valueAt(topicSheet, row, topicHeaders, "标准话题词");
    if (!rawTopic) continue;
    if (!rawTopic.trim().startsWith("#")) {
      irregularTopics.push(`话题规则!第${row}行：${rawTopic}`);
    }
    const importedProductName = valueAt(
      topicSheet,
      row,
      topicHeaders,
      "所属产品",
    );
    topicRules.push({
      productName: importedProductName
        ? resolveImportedProductName(products, importedProductName)
        : null,
      applicableStage:
        normalizeStage(
          valueAt(topicSheet, row, topicHeaders, "产品阶段话题") ||
            valueAt(topicSheet, row, topicHeaders, "适用段位"),
        ) ||
        null,
      milkType: valueAt(topicSheet, row, topicHeaders, "奶粉类型") || null,
      topic: normalizeTopic(rawTopic),
      ruleType:
        policyMap[valueAt(topicSheet, row, topicHeaders, "匹配策略")] ||
        "REQUIRED",
      topicCategory:
        categoryMap[valueAt(topicSheet, row, topicHeaders, "话题类别")] ||
        "PRODUCT_COMMON",
      exactMatch: parseBoolean(
        valueAt(topicSheet, row, topicHeaders, "精确匹配"),
        true,
      ),
      clickableRequired: parseBoolean(
        valueAt(topicSheet, row, topicHeaders, "要求可点击"),
        true,
      ),
      minCount: Number(
        valueAt(topicSheet, row, topicHeaders, "最少满足数量") || 1,
      ),
      sortOrder: Number(
        valueAt(topicSheet, row, topicHeaders, "排序") || row * 10,
      ),
      status:
        valueAt(topicSheet, row, topicHeaders, "状态") === "停用"
          ? "INACTIVE"
          : "ACTIVE",
    });
  }
  const duplicateKeys = new Map<string, number>();
  for (const rule of topicRules) {
    const key = [
      rule.productName || "*",
      rule.applicableStage || "*",
      rule.topic,
      rule.topicCategory,
    ].join("|");
    duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);
  }

  return {
    sourceFormat: "STANDARD_TEMPLATE",
    campaign: {
      name,
      month,
      year: Number(campaignValue("活动年份") || month.slice(0, 4)),
      startDate: campaignValue("开始日期"),
      endDate: campaignValue("结束日期"),
      minImageCount: Number(campaignValue("最低图片数量") || 0),
      minBodyLength: MIN_BODY_LENGTH,
      publicRequired: parseBoolean(campaignValue("要求公开")),
      retentionDays: Number(campaignValue("最低保留天数") || 0),
      rewardDescription: campaignValue("奖励说明"),
      customerRegistrationNotes:
        campaignValue("客服登记备注") ||
        unique([
          campaignValue("必须包含产品图片")
            ? `产品图片内容要求：${campaignValue("必须包含产品图片")}`
            : "",
          campaignValue("首图要求"),
          campaignValue("图片禁止内容"),
          campaignValue("视觉复核说明"),
        ]).join("；"),
    },
    products,
    topicRules,
    diagnostics: {
      unrecognizedCells: [],
      missingProductNames: products
        .filter((product) => !product.name)
        .map((product) => product.seriesName || "未命名产品"),
      missingStages: PRODUCT_STAGES.filter(
        (stage) =>
          !topicRules.some(
            (rule) =>
              rule.topicCategory === "PRODUCT_STAGE" &&
              rule.applicableStage === stage,
          ),
      ),
      duplicateTopics: [...duplicateKeys.entries()]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => `${key} 重复 ${count} 次`),
      irregularTopics,
      unrecognizedProductImages: [],
      corrections: [],
    },
  };
}

export async function parseCampaignRuleWorkbook(
  file: File,
  metadata: CampaignImportMetadata,
) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const isStandard = [
    "活动基础规则",
    "产品资料",
    "话题规则",
    "内容参考方向",
  ].every((name) => workbook.getWorksheet(name));
  const normalized = isStandard
    ? parseStandardTemplate(workbook)
    : parseRawCampaign(workbook, metadata);
  await standardizeImportedProducts(normalized);
  validateNormalizedRules(normalized);
  return normalized;
}

async function standardizeImportedProducts(data: NormalizedCampaignRules) {
  const systemProducts = await prisma.product.findMany({
    where: { deletedAt: null },
    include: { aliases: { select: { alias: true } } },
  });
  const remappedNames = new Map<string, string>();
  const matchedSystemIds = new Map<NormalizedProductRule, string>();

  for (const input of data.products) {
    const originalName = input.name;
    const resolution = resolveProductReference(systemProducts, {
      code: input.code,
      name: originalName,
    });
    if (resolution.status === "AMBIGUOUS") {
      throw new Error(PRODUCT_ALIAS_AMBIGUOUS_MESSAGE);
    }
    if (resolution.status === "MATCHED") {
      const systemProduct = resolution.product;
      matchedSystemIds.set(input, systemProduct.id);
      input.code ||= systemProduct.code;
      input.name = systemProduct.name;
      input.seriesName ||= systemProduct.seriesName || systemProduct.name;
      input.aliases = unique([
        ...input.aliases,
        ...systemProduct.aliases.map((alias) => alias.alias),
        ...(normalizeProductMatchKey(originalName) !==
        normalizeProductMatchKey(systemProduct.name)
          ? [originalName]
          : []),
      ]);
      if (originalName !== systemProduct.name) {
        data.diagnostics.corrections.push(
          `产品“${originalName}”已标准化为“${systemProduct.name}”`,
        );
      }
    }
    remappedNames.set(normalizeProductMatchKey(originalName), input.name);
  }

  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const product of data.products) {
    const key = normalizeProductMatchKey(product.name);
    if (seenNames.has(key)) duplicateNames.add(product.name);
    seenNames.add(key);

    for (const alias of product.aliases) {
      const existing = resolveProductReference(systemProducts, { name: alias });
      if (existing.status === "AMBIGUOUS") {
        throw new Error(PRODUCT_ALIAS_AMBIGUOUS_MESSAGE);
      }
      if (
        existing.status === "MATCHED" &&
        existing.product.id !== matchedSystemIds.get(product)
      ) {
        throw new Error(PRODUCT_ALIAS_AMBIGUOUS_MESSAGE);
      }
    }
  }
  if (duplicateNames.size) {
    throw new Error(`产品资料存在重复产品：${[...duplicateNames].join("、")}`);
  }

  const importedCandidates = data.products.map((product, index) => ({
    ...product,
    id: `normalized-product-${index}`,
  }));
  for (const rule of data.topicRules) {
    if (!rule.productName) continue;
    const remapped = remappedNames.get(normalizeProductMatchKey(rule.productName));
    if (remapped) {
      rule.productName = remapped;
      continue;
    }
    const resolution = resolveProductReference(importedCandidates, {
      name: rule.productName,
    });
    if (resolution.status === "AMBIGUOUS") {
      throw new Error(PRODUCT_ALIAS_AMBIGUOUS_MESSAGE);
    }
    if (resolution.status === "NOT_FOUND") {
      throw new Error(PRODUCT_NOT_RECOGNIZED_MESSAGE);
    }
    rule.productName = resolution.product.name;
  }
}

function validateNormalizedRules(data: NormalizedCampaignRules) {
  if (
    !data.campaign.name ||
    !/^\d{4}-\d{2}$/u.test(data.campaign.month) ||
    !data.campaign.startDate ||
    !data.campaign.endDate
  ) {
    throw new Error("活动名称、月份、开始日期和结束日期必须完整");
  }
  if (!data.products.length) throw new Error("未识别到产品资料");
  if (data.diagnostics.missingProductNames.length) {
    throw new Error("存在缺少产品名称的数据");
  }
  if (data.diagnostics.missingStages.length) {
    throw new Error(
      `缺少产品阶段话题规则：${data.diagnostics.missingStages.join("、")}`,
    );
  }
  if (data.diagnostics.irregularTopics.length) {
    throw new Error("存在不规范话题，请先修正");
  }
}

export async function buildCampaignImportPreview(
  data: NormalizedCampaignRules,
) {
  const existingCampaign = await prisma.campaign.findFirst({
    where: { name: data.campaign.name, month: data.campaign.month },
  });
  const existingProducts = await prisma.product.findMany({
    where: { name: { in: data.products.map((product) => product.name) } },
    select: { id: true, name: true },
  });
  const existingProductNames = new Set(
    existingProducts.map((product) => product.name),
  );
  const newProducts = data.products.filter(
    (product) => !existingProductNames.has(product.name),
  );
  const updatedProducts = data.products.filter((product) =>
    existingProductNames.has(product.name),
  );
  return {
    ...data,
    counts: {
      campaigns: 1,
      products: data.products.length,
      topicRules: data.topicRules.length,
      unrecognizedCells: data.diagnostics.unrecognizedCells.length,
      missingProductNames: data.diagnostics.missingProductNames.length,
      missingStages: data.diagnostics.missingStages.length,
      duplicateTopics: data.diagnostics.duplicateTopics.length,
      irregularTopics: data.diagnostics.irregularTopics.length,
      unrecognizedProductImages:
        data.diagnostics.unrecognizedProductImages.length,
    },
    changes: {
      create: {
        campaigns: existingCampaign ? 0 : 1,
        products: newProducts.map((product) => product.name),
        topicRules: existingCampaign ? 0 : data.topicRules.length,
      },
      update: {
        campaigns: existingCampaign ? 1 : 0,
        products: updatedProducts.map((product) => product.name),
        topicRules: existingCampaign ? data.topicRules.length : 0,
      },
    },
  };
}

export async function commitCampaignRuleImport(
  data: NormalizedCampaignRules,
  fileName: string,
  userId: string,
) {
  const inferredBrandName = inferSharedBrandName(data.products);
  const result = await prisma.$transaction(async (tx) => {
    const products = [];
    for (const input of data.products) {
      const existing = await tx.product.findFirst({
        where: { name: input.name },
      });
      const product = existing
        ? await tx.product.update({
            where: { id: existing.id },
            data: {
              ruleSource: "LOCAL_DRAFT",
              code: input.code || existing.code,
              name: input.name,
              brandName: inferredBrandName || existing.brandName,
              seriesName: input.seriesName,
              contentDirection: input.contentDirection,
              status: "ACTIVE",
              deletedAt: null,
            },
          })
        : await tx.product.create({
            data: {
              ruleSource: "LOCAL_DRAFT",
              code: input.code,
              name: input.name,
              brandName: inferredBrandName || input.seriesName,
              seriesName: input.seriesName,
              contentDirection: input.contentDirection,
            },
          });
      for (const alias of input.aliases) {
        await tx.productAlias.upsert({
          where: { productId_alias: { productId: product.id, alias } },
          create: { productId: product.id, alias },
          update: {},
        });
      }
      products.push(product);
    }

    const existingCampaign = await tx.campaign.findFirst({
      where: { name: data.campaign.name, month: data.campaign.month },
    });
    const campaignData = {
      ruleSource: "LOCAL_DRAFT",
      productId: null,
      name: data.campaign.name,
      month: data.campaign.month,
      year: data.campaign.year,
      startDate: new Date(data.campaign.startDate),
      endDate: new Date(data.campaign.endDate),
      minImageCount: data.campaign.minImageCount,
      productImageRequired: false,
      firstImageRequirement: null,
      prohibitedImageGuidance: null,
      bodyRequired: true,
      minBodyLength: MIN_BODY_LENGTH,
      publicRequired: data.campaign.publicRequired,
      retentionDays: data.campaign.retentionDays,
      rewardDescription: data.campaign.rewardDescription,
      visualReviewGuidance: null,
      customerRegistrationNotes: data.campaign.customerRegistrationNotes,
      clickableTopicRequired: true,
      status: "ACTIVE",
      deletedAt: null,
    };
    const campaign = existingCampaign
      ? await tx.campaign.update({
          where: { id: existingCampaign.id },
          data: { ...campaignData, ruleVersion: { increment: 1 } },
        })
      : await tx.campaign.create({ data: campaignData });

    await tx.campaignProduct.deleteMany({ where: { campaignId: campaign.id } });
    await tx.campaignProduct.createMany({
      data: products.map((product, index) => ({
        campaignId: campaign.id,
        productId: product.id,
        sortOrder: index,
      })),
    });
    await tx.topicRule.deleteMany({ where: { campaignId: campaign.id } });
    const productByName = new Map(
      products.map((product) => [product.name, product.id]),
    );
    await tx.topicRule.createMany({
      data: data.topicRules.map((rule) => ({
        ruleSource: "LOCAL_DRAFT",
        brandName: inferredBrandName,
        campaignId: campaign.id,
        productId: rule.productName
          ? productByName.get(rule.productName) || null
          : null,
        scope: "CAMPAIGN",
        ruleType: rule.ruleType,
        topicCategory: rule.topicCategory,
        applicableStage: rule.applicableStage,
        milkType: rule.milkType,
        topic: normalizeTopic(rule.topic),
        exactMatch: rule.exactMatch,
        clickableRequired: rule.clickableRequired,
        caseSensitive: false,
        minCount: rule.minCount,
        sortOrder: rule.sortOrder,
        version: campaign.ruleVersion,
        status: rule.status,
        notes:
          rule.topicCategory === "PRODUCT_STAGE"
            ? `${rule.milkType || ""} ${rule.applicableStage || ""}`.trim()
            : null,
      })),
    });
    return { campaign, products };
  });

  await prisma.importRecord.create({
    data: {
      fileName,
      importType: "CAMPAIGN_RULE",
      totalCount: 1 + data.products.length + data.topicRules.length,
      validCount: 1 + data.products.length + data.topicRules.length,
      invalidCount: 0,
      skippedCount: 0,
      status: "COMPLETED",
      summary: JSON.stringify({
        campaignId: result.campaign.id,
        products: result.products.length,
        topicRules: data.topicRules.length,
        sourceFormat: data.sourceFormat,
        corrections: data.diagnostics.corrections,
      }),
      createdBy: userId,
    },
  });
  await prisma.operationLog.create({
    data: {
      userId,
      action: "IMPORT_CAMPAIGN_RULES",
      entityType: "CAMPAIGN",
      entityId: result.campaign.id,
      summary: `导入活动规则：${result.campaign.name}，${result.products.length} 个产品，${data.topicRules.length} 条话题规则`,
    },
  });
  return result;
}

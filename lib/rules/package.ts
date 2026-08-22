import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  normalizeStoreNameForMatch,
  normalizeStoreTopicForMatch,
  storeTopicWithHash,
} from "@/lib/store-topic-config";
import { normalizeTopic } from "@/lib/topic";
import {
  DEFAULT_PAGE_STATUS_RULES,
  DEFAULT_RULE_STAGE_GROUPS,
} from "./defaults";
import {
  BUILTIN_IMPORT_EXPORT_TEMPLATES,
} from "@/lib/import-export-templates/config";
import { validateImportExportTemplates } from "@/lib/import-export-templates/validation";
import {
  RULE_PACKAGE_SCHEMA_VERSION,
  type RulePackagePayload,
  type RulePackageStageGroup,
} from "./types";

const nonEmpty = z.string().trim().min(1);
const nullableText = z.string().nullable();
const storeValueSchema = z.object({
  value: nonEmpty,
  enabled: z.boolean(),
  sortOrder: z.number().int(),
});

const payloadSchema = z.object({
  ruleVersion: nonEmpty,
  schemaVersion: z.literal(RULE_PACKAGE_SCHEMA_VERSION),
  publishedAt: z.string().datetime(),
  minimumAppVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/u),
  products: z.array(
    z.object({
      key: nonEmpty,
      code: nullableText,
      name: nonEmpty,
      brand: nonEmpty,
      series: nullableText,
      category: nullableText,
      aliases: z.array(nonEmpty),
      contentDirection: nullableText,
      status: nonEmpty,
    }),
  ),
  campaigns: z.array(
    z.object({
      key: nonEmpty,
      contentChannel: z.enum(["XIAOHONGSHU", "DOUYIN"]).optional().default("XIAOHONGSHU"),
      name: nonEmpty,
      month: z.string().regex(/^\d{4}-\d{2}$/u),
      year: z.number().int().nullable(),
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
      productKeys: z.array(nonEmpty).min(1),
      minImageCount: z.number().int().min(0),
      productImageRequired: z.boolean().optional().default(false),
      firstImageRequirement: nullableText.optional().default(null),
      prohibitedImageGuidance: nullableText.optional().default(null),
      bodyRequired: z.boolean(),
      minBodyLength: z.number().int().min(0),
      publicRequired: z.boolean(),
      retentionDays: z.number().int().min(0),
      rewardDescription: nullableText,
      visualReviewGuidance: nullableText.optional().default(null),
      customerRegistrationNotes: nullableText,
      clickableTopicRequired: z.boolean(),
      ruleRevision: z.number().int().min(1),
      status: nonEmpty,
    }),
  ),
  stageGroups: z.array(
    z.object({
      key: nonEmpty,
      label: nonEmpty,
      canonicalStages: z.array(nonEmpty).min(1),
      bodyTerms: z.array(nonEmpty).min(1),
      requireBodyStage: z.boolean().optional().default(false),
      requiredTopic: z.string().regex(/^#[^#\s]+$/u),
      sortOrder: z.number().int(),
      status: nonEmpty,
    }),
  ),
  topicRules: z.array(
    z.object({
      key: nonEmpty,
      contentChannel: z.enum(["XIAOHONGSHU", "DOUYIN", "ALL"]).optional().default("XIAOHONGSHU"),
      brand: nonEmpty.nullable().optional(),
      campaignKey: nullableText,
      productKey: nullableText,
      scope: nonEmpty,
      ruleType: nonEmpty,
      topicCategory: nonEmpty,
      applicableStage: nullableText,
      milkType: nullableText,
      topic: z.string().regex(/^#[^#\s]+$/u),
      exactMatch: z.boolean(),
      clickableRequired: z.boolean(),
      caseSensitive: z.boolean(),
      minCount: z.number().int().min(0),
      sortOrder: z.number().int(),
      revision: z.number().int().min(1),
      status: nonEmpty,
      notes: nullableText.optional().default(null),
    }),
  ),
  storeTopicRules: z
    .array(
      z.object({
        key: nonEmpty,
        commercePlatform: z.enum([
          "JD",
          "DOUYIN_ECOMMERCE",
          "TMALL",
          "TAOBAO",
        ]),
        storeName: nonEmpty,
        enabled: z.boolean(),
        storeAliases: z.array(storeValueSchema),
        acceptedTopics: z.array(storeValueSchema).min(1),
        acceptedAliases: z.array(storeValueSchema),
        requiredTopics: z.array(storeValueSchema),
      }),
    )
    .optional(),
  pageStatusRules: z.object({
    normalStatuses: z.array(nonEmpty).min(1),
    technicalFailureStatuses: z.array(nonEmpty),
  }),
  importExportTemplates: z.unknown().optional(),
});

function stableKey(prefix: string, parts: Array<string | null | undefined>) {
  const digest = createHash("sha256")
    .update(parts.map((value) => String(value || "").trim()).join("\u001f"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${digest}`;
}

export function storeTopicRuleStableKey(
  commercePlatform: string,
  storeName: string,
) {
  return stableKey("store", [
    commercePlatform,
    normalizeStoreNameForMatch(storeName),
  ]);
}

function compareSemver(left: string, right: string) {
  const parse = (value: string) =>
    value
      .split(/[.+-]/u)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function normalizedRuleBrand(brand: string | null | undefined) {
  return brand?.trim() === "爱他美" ? "达能" : brand?.trim() || null;
}

function uniqueValues(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label}存在重复值：${value}`);
    seen.add(value);
  }
}

export function validateRulePayload(input: unknown): RulePackagePayload {
  const payload = payloadSchema.parse(input) as RulePackagePayload;
  if (payload.importExportTemplates) {
    payload.importExportTemplates = validateImportExportTemplates(
      payload.importExportTemplates,
    );
  }
  uniqueValues(payload.products.map((item) => item.key), "产品键");
  uniqueValues(payload.campaigns.map((item) => item.key), "活动键");
  uniqueValues(payload.stageGroups.map((item) => item.key), "阶段组键");
  uniqueValues(payload.topicRules.map((item) => item.key), "话题规则键");

  if (payload.storeTopicRules !== undefined) {
    if (compareSemver(payload.minimumAppVersion, "1.1.17") < 0) {
      throw new Error("包含店铺规则的规则包最低软件版本不能低于 1.1.17");
    }
    uniqueValues(
      payload.storeTopicRules.map((item) => item.key),
      "店铺规则键",
    );
    const canonicalIdentities = new Set<string>();
    const resolvingNames = new Map<string, string>();
    for (const rule of payload.storeTopicRules) {
      const normalizedStoreName = normalizeStoreNameForMatch(rule.storeName);
      const identity = `${rule.commercePlatform}\u001f${normalizedStoreName}`;
      if (
        rule.key !==
        storeTopicRuleStableKey(rule.commercePlatform, rule.storeName)
      ) {
        throw new Error(
          `店铺规则稳定键与平台/标准店铺不一致：${rule.storeName}`,
        );
      }
      if (canonicalIdentities.has(identity)) {
        throw new Error(
          `同一平台存在重复标准店铺：${rule.commercePlatform} / ${rule.storeName}`,
        );
      }
      canonicalIdentities.add(identity);
      resolvingNames.set(identity, `标准店铺“${rule.storeName}”`);
    }

    for (const rule of payload.storeTopicRules) {
      const entryNames = new Map<string, string>();
      const assertEntry = (
        value: string,
        label: string,
        kind: "TOPIC" | "STORE_NAME",
      ) => {
        const normalized =
          kind === "TOPIC"
            ? normalizeStoreTopicForMatch(value)
            : normalizeStoreNameForMatch(value);
        if (kind === "TOPIC") {
          const normalizedTopic = storeTopicWithHash(value);
          if (normalizeTopic(normalizedTopic) !== normalizedTopic) {
            throw new Error(`${label}格式不规范：${value}`);
          }
        }
        const existing = entryNames.get(normalized);
        if (existing) {
          throw new Error(
            `店铺“${rule.storeName}”存在规范化 Entry 冲突：${existing} / ${label}`,
          );
        }
        entryNames.set(normalized, label);
        return normalized;
      };

      for (const item of rule.acceptedTopics) {
        assertEntry(item.value, `可接受话题“${item.value}”`, "TOPIC");
      }
      for (const item of rule.requiredTopics) {
        assertEntry(item.value, `附加必需话题“${item.value}”`, "TOPIC");
      }
      for (const item of rule.acceptedAliases) {
        const normalized = assertEntry(
          item.value,
          `历史兼容别名“${item.value}”`,
          "TOPIC",
        );
        const identity = `${rule.commercePlatform}\u001f${normalized}`;
        const occupied = resolvingNames.get(identity);
        if (occupied) {
          throw new Error(
            `STORE_ALIAS_COLLISION：${rule.commercePlatform} / ${item.value} 已被${occupied}占用`,
          );
        }
        resolvingNames.set(
          identity,
          `店铺“${rule.storeName}”的 ACCEPTED_ALIAS`,
        );
      }
      for (const item of rule.storeAliases) {
        const normalized = assertEntry(
          item.value,
          `导入别名“${item.value}”`,
          "STORE_NAME",
        );
        const identity = `${rule.commercePlatform}\u001f${normalized}`;
        const occupied = resolvingNames.get(identity);
        if (occupied) {
          throw new Error(
            `STORE_ALIAS_COLLISION：${rule.commercePlatform} / ${item.value} 已被${occupied}占用`,
          );
        }
        resolvingNames.set(
          identity,
          `店铺“${rule.storeName}”的 STORE_ALIAS`,
        );
      }
    }
  }

  const productKeys = new Set(payload.products.map((item) => item.key));
  const productBrandByKey = new Map(
    payload.products.map((item) => [item.key, normalizedRuleBrand(item.brand)]),
  );
  const campaignKeys = new Set(payload.campaigns.map((item) => item.key));
  const campaignBrandsByKey = new Map(
    payload.campaigns.map((campaign) => [
      campaign.key,
      new Set(
        campaign.productKeys
          .map((key) => productBrandByKey.get(key))
          .filter((brand): brand is string => Boolean(brand)),
      ),
    ]),
  );
  const stageKeys = new Set(payload.stageGroups.map((item) => item.key));
  for (const campaign of payload.campaigns) {
    for (const key of campaign.productKeys) {
      if (!productKeys.has(key)) {
        throw new Error(`活动“${campaign.name}”引用了不存在的产品：${key}`);
      }
    }
    if (new Date(campaign.startDate) > new Date(campaign.endDate)) {
      throw new Error(`活动“${campaign.name}”的开始日期晚于结束日期`);
    }
  }
  for (const rule of payload.topicRules) {
    if (rule.productKey && !productKeys.has(rule.productKey)) {
      throw new Error(`话题规则引用了不存在的产品：${rule.productKey}`);
    }
    if (rule.campaignKey && !campaignKeys.has(rule.campaignKey)) {
      throw new Error(`话题规则引用了不存在的活动：${rule.campaignKey}`);
    }
    const ruleBrand = normalizedRuleBrand(rule.brand);
    const productBrand = rule.productKey
      ? productBrandByKey.get(rule.productKey)
      : null;
    if (ruleBrand && productBrand && ruleBrand !== productBrand) {
      throw new Error(`话题规则品牌与所属产品不一致：${rule.topic}`);
    }
    if (
      ruleBrand &&
      rule.campaignKey &&
      !campaignBrandsByKey.get(rule.campaignKey)?.has(ruleBrand)
    ) {
      throw new Error(`话题规则品牌与所属活动不一致：${rule.topic}`);
    }
    if (
      rule.topicCategory === "PRODUCT_STAGE" &&
      (!rule.applicableStage || !stageKeys.has(rule.applicableStage))
    ) {
      throw new Error(`阶段话题未关联有效阶段组：${rule.topic}`);
    }
    if (normalizeTopic(rule.topic) !== rule.topic) {
      throw new Error(`话题格式不规范：${rule.topic}`);
    }
  }
  return payload;
}

export function normalizeLocalStageReferences(
  storedGroups: RulePackageStageGroup[],
  topicRules: RulePackagePayload["topicRules"],
) {
  const stageGroupsByKey = new Map(
    DEFAULT_RULE_STAGE_GROUPS.map((group) => [group.key, group]),
  );
  for (const group of storedGroups) stageGroupsByKey.set(group.key, group);
  const stageGroups = [...stageGroupsByKey.values()].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );
  const stageKeys = new Set(stageGroups.map((group) => group.key));
  const stageKeyByTopic = new Map(
    stageGroups.map((group) => [normalizeTopic(group.requiredTopic), group.key]),
  );

  return {
    stageGroups,
    topicRules: topicRules.map((rule) => {
      if (
        rule.topicCategory !== "PRODUCT_STAGE" ||
        (rule.applicableStage && stageKeys.has(rule.applicableStage))
      ) {
        return rule;
      }
      const inferredStage = stageKeyByTopic.get(normalizeTopic(rule.topic));
      return inferredStage
        ? { ...rule, applicableStage: inferredStage }
        : rule;
    }),
  };
}

export async function exportCurrentRulePayload(options?: {
  ruleVersion?: string;
  minimumAppVersion?: string;
  publishedAt?: Date;
}, database: PrismaClient = prisma) {
  const [
    products,
    campaigns,
    topicRules,
    storedGroups,
    storeTopicRules,
    syncState,
  ] =
    await database.$transaction([
      database.product.findMany({
        where: { deletedAt: null },
        include: { aliases: true },
        orderBy: [{ createdAt: "asc" }, { name: "asc" }],
      }),
      database.campaign.findMany({
        where: { deletedAt: null },
        include: { products: { orderBy: { sortOrder: "asc" } } },
        orderBy: [{ startDate: "asc" }, { name: "asc" }],
      }),
      database.topicRule.findMany({
        orderBy: [{ campaignId: "asc" }, { sortOrder: "asc" }],
      }),
      database.ruleStageGroup.findMany({ orderBy: { sortOrder: "asc" } }),
      database.storeTopicRule.findMany({
        where: { deletedAt: null },
        include: {
          topicEntries: {
            where: { deletedAt: null },
            orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }],
          },
        },
        orderBy: [
          { commercePlatform: "asc" },
          { normalizedStoreName: "asc" },
        ],
      }),
      database.ruleSyncState.findUnique({ where: { id: "active" } }),
    ]);

  const productKeyById = new Map(
    products.map((product) => [
      product.id,
      product.publishedKey ||
        stableKey("product", [product.code, product.brandName, product.name]),
    ]),
  );
  const productBrandById = new Map(
    products.map((product) => [product.id, product.brandName]),
  );
  const campaignBrandById = new Map(
    campaigns.map((campaign) => {
      const firstProductId =
        campaign.products[0]?.productId || campaign.productId || null;
      return [
        campaign.id,
        firstProductId ? productBrandById.get(firstProductId) || null : null,
      ];
    }),
  );
  const campaignKeyById = new Map(
    campaigns.map((campaign) => [
      campaign.id,
      campaign.publishedKey ||
        stableKey("activity", [
          campaign.contentChannel,
          campaign.name,
          campaign.month,
        ]),
    ]),
  );
  const storedStageGroups: RulePackageStageGroup[] = storedGroups.map(
    (group) => ({
        key: group.key,
        label: group.label,
        canonicalStages: JSON.parse(group.canonicalStages) as string[],
        bodyTerms: JSON.parse(group.bodyTerms) as string[],
        requireBodyStage: group.requireBodyStage,
        requiredTopic: group.requiredTopic,
        sortOrder: group.sortOrder,
        status: group.status,
      }),
  );

  const exportedTopicRules: RulePackagePayload["topicRules"] = topicRules.map(
    (rule) => ({
      key:
        rule.publishedKey ||
        stableKey("topic", [
          rule.brandName,
          rule.campaignId ? campaignKeyById.get(rule.campaignId) : "global",
          rule.productId ? productKeyById.get(rule.productId) : "all-products",
          rule.topicCategory,
          rule.applicableStage,
          normalizeTopic(rule.topic),
        ]),
      contentChannel:
        rule.contentChannel === "DOUYIN" || rule.contentChannel === "ALL"
          ? rule.contentChannel
          : "XIAOHONGSHU",
      brand:
        rule.brandName ||
        (rule.productId ? productBrandById.get(rule.productId) : null) ||
        (rule.campaignId ? campaignBrandById.get(rule.campaignId) : null) ||
        null,
      campaignKey: rule.campaignId
        ? campaignKeyById.get(rule.campaignId) || null
        : null,
      productKey: rule.productId
        ? productKeyById.get(rule.productId) || null
        : null,
      scope: rule.scope,
      ruleType: rule.ruleType,
      topicCategory: rule.topicCategory,
      applicableStage: rule.applicableStage,
      milkType: rule.milkType,
      topic: normalizeTopic(rule.topic),
      exactMatch: rule.exactMatch,
      clickableRequired: rule.clickableRequired,
      caseSensitive: rule.caseSensitive,
      minCount: rule.minCount,
      sortOrder: rule.sortOrder,
      revision: rule.version,
      status: rule.status,
      notes: rule.notes,
    }),
  );
  const normalizedLocalRules = normalizeLocalStageReferences(
    storedStageGroups,
    exportedTopicRules,
  );

  return validateRulePayload({
    ruleVersion:
      options?.ruleVersion ||
      syncState?.currentVersion ||
      "builtin-2026.07.29.1",
    schemaVersion: RULE_PACKAGE_SCHEMA_VERSION,
    publishedAt: (options?.publishedAt || new Date()).toISOString(),
    minimumAppVersion: options?.minimumAppVersion || "1.1.17",
    products: products.map((product) => ({
      key: productKeyById.get(product.id),
      code: product.code,
      name: product.name,
      brand: product.brandName,
      series: product.seriesName,
      category: product.category,
      aliases: product.aliases.map((item) => item.alias),
      contentDirection: product.contentDirection,
      status: product.status,
    })),
    campaigns: campaigns.map((campaign) => ({
      key: campaignKeyById.get(campaign.id),
      contentChannel:
        campaign.contentChannel === "DOUYIN" ? "DOUYIN" : "XIAOHONGSHU",
      name: campaign.name,
      month: campaign.month,
      year: campaign.year,
      startDate: campaign.startDate.toISOString(),
      endDate: campaign.endDate.toISOString(),
      productKeys:
        campaign.products.length > 0
          ? campaign.products.map(
              (link) => productKeyById.get(link.productId)!,
            )
          : campaign.productId && productKeyById.has(campaign.productId)
            ? [productKeyById.get(campaign.productId)!]
            : [],
      minImageCount: campaign.minImageCount,
      productImageRequired: campaign.productImageRequired,
      firstImageRequirement: campaign.firstImageRequirement,
      prohibitedImageGuidance: campaign.prohibitedImageGuidance,
      bodyRequired: campaign.bodyRequired,
      minBodyLength: campaign.minBodyLength,
      publicRequired: campaign.publicRequired,
      retentionDays: campaign.retentionDays,
      rewardDescription: campaign.rewardDescription,
      visualReviewGuidance: campaign.visualReviewGuidance,
      customerRegistrationNotes: campaign.customerRegistrationNotes,
      clickableTopicRequired: campaign.clickableTopicRequired,
      ruleRevision: campaign.ruleVersion,
      status: campaign.status,
    })),
    stageGroups: normalizedLocalRules.stageGroups,
    topicRules: normalizedLocalRules.topicRules,
    storeTopicRules: storeTopicRules.map((rule) => {
      const valuesByType = (topicType: string) =>
        rule.topicEntries
          .filter((entry) => entry.topicType === topicType)
          .map((entry) => ({
            value: entry.topic,
            enabled: entry.enabled,
            sortOrder: entry.sortOrder,
          }));
      return {
        key: storeTopicRuleStableKey(
          rule.commercePlatform,
          rule.normalizedStoreName,
        ),
        commercePlatform: rule.commercePlatform,
        storeName: rule.storeName,
        enabled: rule.enabled,
        storeAliases: valuesByType("STORE_ALIAS"),
        acceptedTopics: valuesByType("ACCEPTED"),
        acceptedAliases: valuesByType("ACCEPTED_ALIAS"),
        requiredTopics: valuesByType("REQUIRED"),
      };
    }),
    pageStatusRules: DEFAULT_PAGE_STATUS_RULES,
    importExportTemplates: syncState?.templateConfigJson
      ? validateImportExportTemplates(
          JSON.parse(syncState.templateConfigJson),
        )
      : BUILTIN_IMPORT_EXPORT_TEMPLATES,
  });
}

export function payloadSha256(payload: RulePackagePayload) {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export async function applyRulePayload(
  input: unknown,
  source: "BUILTIN" | "GITHUB" | "RESTORE",
  database: PrismaClient = prisma,
) {
  const payload = validateRulePayload(input);
  const previous = await exportCurrentRulePayload(undefined, database);
  const previousState = await database.ruleSyncState.findUnique({
    where: { id: "active" },
  });

  return database.$transaction(async (tx) => {
    await tx.rulePackageBackup.create({
      data: {
        ruleVersion: previous.ruleVersion,
        schemaVersion: previous.schemaVersion,
        source: previousState?.source || "LOCAL",
        sha256: payloadSha256(previous),
        payloadJson: JSON.stringify(previous),
      },
    });

    if (payload.storeTopicRules !== undefined) {
      const appliedAt = new Date();
      const publishedIdentities = new Set(
        payload.storeTopicRules.map(
          (item) =>
            `${item.commercePlatform}\u001f${normalizeStoreNameForMatch(item.storeName)}`,
        ),
      );
      const existingActiveRules = await tx.storeTopicRule.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          commercePlatform: true,
          normalizedStoreName: true,
        },
      });
      for (const existing of existingActiveRules) {
        const identity =
          `${existing.commercePlatform}\u001f${existing.normalizedStoreName}`;
        if (publishedIdentities.has(identity)) continue;
        await tx.storeTopicEntry.updateMany({
          where: { storeTopicRuleId: existing.id, deletedAt: null },
          data: { enabled: false, deletedAt: appliedAt },
        });
        await tx.storeTopicRule.update({
          where: { id: existing.id },
          data: { enabled: false, deletedAt: appliedAt },
        });
      }

      for (const item of payload.storeTopicRules) {
        const normalizedStoreName = normalizeStoreNameForMatch(item.storeName);
        const expectedTopic = storeTopicWithHash(
          item.acceptedTopics.find((topic) => topic.enabled)?.value ||
            item.acceptedTopics[0].value,
        );
        const existing = await tx.storeTopicRule.findUnique({
          where: {
            commercePlatform_normalizedStoreName: {
              commercePlatform: item.commercePlatform,
              normalizedStoreName,
            },
          },
        });
        const rule = existing
          ? await tx.storeTopicRule.update({
              where: { id: existing.id },
              data: {
                storeName: item.storeName,
                normalizedStoreName,
                expectedTopic,
                enabled: item.enabled,
                deletedAt: null,
              },
            })
          : await tx.storeTopicRule.create({
              data: {
                commercePlatform: item.commercePlatform,
                storeName: item.storeName,
                normalizedStoreName,
                expectedTopic,
                enabled: item.enabled,
              },
            });
        const entries = [
          ...item.storeAliases.map((entry) => ({
            ...entry,
            topic: entry.value,
            topicType: "STORE_ALIAS",
            normalizedTopic: normalizeStoreNameForMatch(entry.value),
          })),
          ...item.acceptedTopics.map((entry) => ({
            ...entry,
            topic: storeTopicWithHash(entry.value),
            topicType: "ACCEPTED",
            normalizedTopic: normalizeStoreTopicForMatch(entry.value),
          })),
          ...item.acceptedAliases.map((entry) => ({
            ...entry,
            topic: storeTopicWithHash(entry.value),
            topicType: "ACCEPTED_ALIAS",
            normalizedTopic: normalizeStoreTopicForMatch(entry.value),
          })),
          ...item.requiredTopics.map((entry) => ({
            ...entry,
            topic: storeTopicWithHash(entry.value),
            topicType: "REQUIRED",
            normalizedTopic: normalizeStoreTopicForMatch(entry.value),
          })),
        ];
        await tx.storeTopicEntry.updateMany({
          where: {
            storeTopicRuleId: rule.id,
            deletedAt: null,
            ...(entries.length
              ? {
                  normalizedTopic: {
                    notIn: entries.map((entry) => entry.normalizedTopic),
                  },
                }
              : {}),
          },
          data: { enabled: false, deletedAt: appliedAt },
        });
        for (const entry of entries) {
          await tx.storeTopicEntry.upsert({
            where: {
              storeTopicRuleId_normalizedTopic: {
                storeTopicRuleId: rule.id,
                normalizedTopic: entry.normalizedTopic,
              },
            },
            create: {
              storeTopicRuleId: rule.id,
              topic: entry.topic,
              normalizedTopic: entry.normalizedTopic,
              topicType: entry.topicType,
              sortOrder: entry.sortOrder,
              enabled: entry.enabled,
            },
            update: {
              topic: entry.topic,
              topicType: entry.topicType,
              sortOrder: entry.sortOrder,
              enabled: entry.enabled,
              deletedAt: null,
            },
          });
        }
      }
    }

    const publishedProductKeys = payload.products.map((item) => item.key);
    const publishedCampaignKeys = payload.campaigns.map((item) => item.key);
    const publishedTopicKeys = payload.topicRules.map((item) => item.key);
    const publishedStageKeys = payload.stageGroups.map((item) => item.key);
    await Promise.all([
      tx.product.updateMany({
        where: {
          ruleSource: { not: "LOCAL_DRAFT" },
          publishedKey: { notIn: publishedProductKeys },
        },
        data: { status: "INACTIVE" },
      }),
      tx.campaign.updateMany({
        where: {
          ruleSource: { not: "LOCAL_DRAFT" },
          publishedKey: { notIn: publishedCampaignKeys },
        },
        data: { status: "INACTIVE" },
      }),
      tx.topicRule.updateMany({
        where: {
          ruleSource: { not: "LOCAL_DRAFT" },
          publishedKey: { notIn: publishedTopicKeys },
        },
        data: { status: "INACTIVE" },
      }),
      tx.ruleStageGroup.updateMany({
        where: {
          ruleSource: { not: "LOCAL_DRAFT" },
          key: { notIn: publishedStageKeys },
        },
        data: { status: "INACTIVE" },
      }),
    ]);

    const productIds = new Map<string, string>();
    for (const item of payload.products) {
      const existing =
        (await tx.product.findUnique({
          where: { publishedKey: item.key },
        })) ||
        (item.code
          ? await tx.product.findUnique({ where: { code: item.code } })
          : null) ||
        (await tx.product.findFirst({ where: { name: item.name } }));
      const product = existing
        ? await tx.product.update({
            where: { id: existing.id },
            data: {
              publishedKey: item.key,
              ruleSource: source,
              code: item.code,
              name: item.name,
              brandName: normalizedRuleBrand(item.brand)!,
              seriesName: item.series,
              category: item.category,
              contentDirection: item.contentDirection,
              status: item.status,
              deletedAt: null,
            },
          })
        : await tx.product.create({
            data: {
              publishedKey: item.key,
              ruleSource: source,
              code: item.code,
              name: item.name,
              brandName: normalizedRuleBrand(item.brand)!,
              seriesName: item.series,
              category: item.category,
              contentDirection: item.contentDirection,
              status: item.status,
            },
          });
      await tx.productAlias.deleteMany({ where: { productId: product.id } });
      if (item.aliases.length) {
        await tx.productAlias.createMany({
          data: item.aliases.map((alias) => ({
            productId: product.id,
            alias,
          })),
        });
      }
      productIds.set(item.key, product.id);
    }

    const campaignIds = new Map<string, string>();
    for (const item of payload.campaigns) {
      const existing =
        (await tx.campaign.findUnique({
          where: { publishedKey: item.key },
        })) ||
        (await tx.campaign.findFirst({
          where: {
            name: item.name,
            month: item.month,
            contentChannel: item.contentChannel,
          },
        }));
      const data = {
        publishedKey: item.key,
        ruleSource: source,
        productId: null,
        name: item.name,
        contentChannel: item.contentChannel,
        month: item.month,
        year: item.year,
        startDate: new Date(item.startDate),
        endDate: new Date(item.endDate),
        minImageCount: item.minImageCount,
        productImageRequired: item.productImageRequired,
        firstImageRequirement: item.firstImageRequirement,
        prohibitedImageGuidance: item.prohibitedImageGuidance,
        bodyRequired: item.bodyRequired,
        minBodyLength: item.minBodyLength,
        publicRequired: item.publicRequired,
        retentionDays: item.retentionDays,
        rewardDescription: item.rewardDescription,
        visualReviewGuidance: item.visualReviewGuidance,
        customerRegistrationNotes: item.customerRegistrationNotes,
        clickableTopicRequired: item.clickableTopicRequired,
        ruleVersion: item.ruleRevision,
        status: item.status,
        deletedAt: null,
      };
      const campaign = existing
        ? await tx.campaign.update({ where: { id: existing.id }, data })
        : await tx.campaign.create({ data });
      await tx.campaignProduct.deleteMany({
        where: { campaignId: campaign.id },
      });
      await tx.campaignProduct.createMany({
        data: item.productKeys.map((productKey, index) => ({
          campaignId: campaign.id,
          productId: productIds.get(productKey)!,
          sortOrder: index,
        })),
      });
      campaignIds.set(item.key, campaign.id);
    }

    for (const group of payload.stageGroups) {
      await tx.ruleStageGroup.upsert({
        where: { key: group.key },
        create: {
          key: group.key,
          label: group.label,
          canonicalStages: JSON.stringify(group.canonicalStages),
          bodyTerms: JSON.stringify(group.bodyTerms),
          requireBodyStage: group.requireBodyStage,
          requiredTopic: group.requiredTopic,
          sortOrder: group.sortOrder,
          status: group.status,
          ruleVersion: payload.ruleVersion,
          ruleSource: source,
        },
        update: {
          label: group.label,
          canonicalStages: JSON.stringify(group.canonicalStages),
          bodyTerms: JSON.stringify(group.bodyTerms),
          requireBodyStage: group.requireBodyStage,
          requiredTopic: group.requiredTopic,
          sortOrder: group.sortOrder,
          status: group.status,
          ruleVersion: payload.ruleVersion,
          ruleSource: source,
        },
      });
    }

    for (const item of payload.topicRules) {
      const inferredBrand = normalizedRuleBrand(
        item.brand ||
        (item.productKey
          ? payload.products.find((product) => product.key === item.productKey)
              ?.brand
          : null) ||
        (item.campaignKey
          ? payload.campaigns
              .find((campaign) => campaign.key === item.campaignKey)
              ?.productKeys.map(
                (productKey) =>
                  payload.products.find((product) => product.key === productKey)
                    ?.brand,
              )
              .find(Boolean)
          : null) ||
        null,
      );
      const data = {
        publishedKey: item.key,
        ruleSource: source,
        campaignId: item.campaignKey
          ? campaignIds.get(item.campaignKey) || null
          : null,
        productId: item.productKey
          ? productIds.get(item.productKey) || null
          : null,
        brandName: inferredBrand,
        contentChannel: item.contentChannel,
        scope: item.scope,
        ruleType: item.ruleType,
        topicCategory: item.topicCategory,
        applicableStage: item.applicableStage,
        milkType: item.milkType,
        topic: normalizeTopic(item.topic),
        exactMatch: item.exactMatch,
        clickableRequired: item.clickableRequired,
        caseSensitive: item.caseSensitive,
        minCount: item.minCount,
        sortOrder: item.sortOrder,
        version: item.revision,
        status: item.status,
        notes: item.notes,
      };
      await tx.topicRule.upsert({
        where: { publishedKey: item.key },
        create: data,
        update: data,
      });
    }

    const [storeTopicRuleCount, storeAliasCount] = await Promise.all([
      tx.storeTopicRule.count({ where: { deletedAt: null } }),
      tx.storeTopicEntry.count({
        where: {
          topicType: "STORE_ALIAS",
          deletedAt: null,
          storeTopicRule: { deletedAt: null },
        },
      }),
    ]);
    const counts = {
      products: payload.products.length,
      activities: payload.campaigns.length,
      stageGroups: payload.stageGroups.length,
      topicRules: payload.topicRules.length,
      storeTopicRules: storeTopicRuleCount,
      storeAliases: storeAliasCount,
    };
    const templates =
      payload.importExportTemplates || BUILTIN_IMPORT_EXPORT_TEMPLATES;
    await tx.ruleSyncState.upsert({
      where: { id: "active" },
      create: {
        id: "active",
        currentVersion: payload.ruleVersion,
        schemaVersion: payload.schemaVersion,
        source,
        status: source === "BUILTIN" ? "USING_BUILTIN" : "COMPLETED",
        countsJson: JSON.stringify(counts),
        templateVersion: templates.templateVersion,
        templateSchemaVersion: templates.schemaVersion,
        templateConfigJson: JSON.stringify(templates),
        previousVersion: previousState?.currentVersion || null,
        lastSyncedAt: new Date(),
      },
      update: {
        currentVersion: payload.ruleVersion,
        schemaVersion: payload.schemaVersion,
        source,
        status: source === "BUILTIN" ? "USING_BUILTIN" : "COMPLETED",
        countsJson: JSON.stringify(counts),
        templateVersion: templates.templateVersion,
        templateSchemaVersion: templates.schemaVersion,
        templateConfigJson: JSON.stringify(templates),
        previousVersion: previousState?.currentVersion || null,
        lastSyncedAt: new Date(),
      },
    });
    return { payload, counts };
  });
}

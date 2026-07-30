import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeTopic } from "@/lib/topic";
import {
  DEFAULT_PAGE_STATUS_RULES,
  DEFAULT_RULE_STAGE_GROUPS,
} from "./defaults";
import {
  RULE_PACKAGE_SCHEMA_VERSION,
  type RulePackagePayload,
  type RulePackageStageGroup,
} from "./types";

const nonEmpty = z.string().trim().min(1);
const nullableText = z.string().nullable();

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
      name: nonEmpty,
      month: z.string().regex(/^\d{4}-\d{2}$/u),
      year: z.number().int().nullable(),
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
      productKeys: z.array(nonEmpty).min(1),
      minImageCount: z.number().int().min(0),
      bodyRequired: z.boolean(),
      minBodyLength: z.number().int().min(0),
      publicRequired: z.boolean(),
      retentionDays: z.number().int().min(0),
      rewardDescription: nullableText,
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
      requiredTopic: z.string().regex(/^#[^#\s]+$/u),
      sortOrder: z.number().int(),
      status: nonEmpty,
    }),
  ),
  topicRules: z.array(
    z.object({
      key: nonEmpty,
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
    }),
  ),
  pageStatusRules: z.object({
    normalStatuses: z.array(nonEmpty).min(1),
    technicalFailureStatuses: z.array(nonEmpty),
  }),
});

function stableKey(prefix: string, parts: Array<string | null | undefined>) {
  const digest = createHash("sha256")
    .update(parts.map((value) => String(value || "").trim()).join("\u001f"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${digest}`;
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
  uniqueValues(payload.products.map((item) => item.key), "产品键");
  uniqueValues(payload.campaigns.map((item) => item.key), "活动键");
  uniqueValues(payload.stageGroups.map((item) => item.key), "阶段组键");
  uniqueValues(payload.topicRules.map((item) => item.key), "话题规则键");

  const productKeys = new Set(payload.products.map((item) => item.key));
  const campaignKeys = new Set(payload.campaigns.map((item) => item.key));
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

export async function exportCurrentRulePayload(options?: {
  ruleVersion?: string;
  minimumAppVersion?: string;
  publishedAt?: Date;
}) {
  const [products, campaigns, topicRules, storedGroups, syncState] =
    await prisma.$transaction([
      prisma.product.findMany({
        where: { deletedAt: null },
        include: { aliases: true },
        orderBy: [{ createdAt: "asc" }, { name: "asc" }],
      }),
      prisma.campaign.findMany({
        where: { deletedAt: null },
        include: { products: { orderBy: { sortOrder: "asc" } } },
        orderBy: [{ startDate: "asc" }, { name: "asc" }],
      }),
      prisma.topicRule.findMany({
        orderBy: [{ campaignId: "asc" }, { sortOrder: "asc" }],
      }),
      prisma.ruleStageGroup.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.ruleSyncState.findUnique({ where: { id: "active" } }),
    ]);

  const productKeyById = new Map(
    products.map((product) => [
      product.id,
      product.publishedKey ||
        stableKey("product", [product.code, product.brandName, product.name]),
    ]),
  );
  const campaignKeyById = new Map(
    campaigns.map((campaign) => [
      campaign.id,
      campaign.publishedKey ||
        stableKey("activity", [campaign.name, campaign.month]),
    ]),
  );
  const stageGroups: RulePackageStageGroup[] = storedGroups.length
    ? storedGroups.map((group) => ({
        key: group.key,
        label: group.label,
        canonicalStages: JSON.parse(group.canonicalStages) as string[],
        bodyTerms: JSON.parse(group.bodyTerms) as string[],
        requiredTopic: group.requiredTopic,
        sortOrder: group.sortOrder,
        status: group.status,
      }))
    : DEFAULT_RULE_STAGE_GROUPS;

  return validateRulePayload({
    ruleVersion:
      options?.ruleVersion ||
      syncState?.currentVersion ||
      "builtin-2026.07.29.1",
    schemaVersion: RULE_PACKAGE_SCHEMA_VERSION,
    publishedAt: (options?.publishedAt || new Date()).toISOString(),
    minimumAppVersion: options?.minimumAppVersion || "1.0.0",
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
      bodyRequired: campaign.bodyRequired,
      minBodyLength: campaign.minBodyLength,
      publicRequired: campaign.publicRequired,
      retentionDays: campaign.retentionDays,
      rewardDescription: campaign.rewardDescription,
      customerRegistrationNotes: campaign.customerRegistrationNotes,
      clickableTopicRequired: campaign.clickableTopicRequired,
      ruleRevision: campaign.ruleVersion,
      status: campaign.status,
    })),
    stageGroups,
    topicRules: topicRules.map((rule) => ({
      key:
        rule.publishedKey ||
        stableKey("topic", [
          rule.campaignId ? campaignKeyById.get(rule.campaignId) : "global",
          rule.productId ? productKeyById.get(rule.productId) : "all-products",
          rule.topicCategory,
          rule.applicableStage,
          normalizeTopic(rule.topic),
        ]),
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
    })),
    pageStatusRules: DEFAULT_PAGE_STATUS_RULES,
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
) {
  const payload = validateRulePayload(input);
  const previous = await exportCurrentRulePayload();
  const previousState = await prisma.ruleSyncState.findUnique({
    where: { id: "active" },
  });

  return prisma.$transaction(async (tx) => {
    await tx.rulePackageBackup.create({
      data: {
        ruleVersion: previous.ruleVersion,
        schemaVersion: previous.schemaVersion,
        source: previousState?.source || "LOCAL",
        sha256: payloadSha256(previous),
        payloadJson: JSON.stringify(previous),
      },
    });

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
              brandName: item.brand,
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
              brandName: item.brand,
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
          where: { name: item.name, month: item.month },
        }));
      const data = {
        publishedKey: item.key,
        ruleSource: source,
        productId: null,
        name: item.name,
        month: item.month,
        year: item.year,
        startDate: new Date(item.startDate),
        endDate: new Date(item.endDate),
        minImageCount: item.minImageCount,
        bodyRequired: item.bodyRequired,
        minBodyLength: item.minBodyLength,
        publicRequired: item.publicRequired,
        retentionDays: item.retentionDays,
        rewardDescription: item.rewardDescription,
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
          requiredTopic: group.requiredTopic,
          sortOrder: group.sortOrder,
          status: group.status,
          ruleVersion: payload.ruleVersion,
          ruleSource: source,
        },
      });
    }

    for (const item of payload.topicRules) {
      const data = {
        publishedKey: item.key,
        ruleSource: source,
        campaignId: item.campaignKey
          ? campaignIds.get(item.campaignKey) || null
          : null,
        productId: item.productKey
          ? productIds.get(item.productKey) || null
          : null,
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
      };
      await tx.topicRule.upsert({
        where: { publishedKey: item.key },
        create: data,
        update: data,
      });
    }

    const counts = {
      products: payload.products.length,
      activities: payload.campaigns.length,
      stageGroups: payload.stageGroups.length,
      topicRules: payload.topicRules.length,
    };
    await tx.ruleSyncState.upsert({
      where: { id: "active" },
      create: {
        id: "active",
        currentVersion: payload.ruleVersion,
        schemaVersion: payload.schemaVersion,
        source,
        status: source === "BUILTIN" ? "USING_BUILTIN" : "COMPLETED",
        countsJson: JSON.stringify(counts),
        previousVersion: previousState?.currentVersion || null,
        lastSyncedAt: new Date(),
      },
      update: {
        currentVersion: payload.ruleVersion,
        schemaVersion: payload.schemaVersion,
        source,
        status: source === "BUILTIN" ? "USING_BUILTIN" : "COMPLETED",
        countsJson: JSON.stringify(counts),
        previousVersion: previousState?.currentVersion || null,
        lastSyncedAt: new Date(),
      },
    });
    return { payload, counts };
  });
}

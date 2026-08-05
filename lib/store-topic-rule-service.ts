import { prisma } from "@/lib/db";
import {
  buildStoreTopicAuditRequirement,
  expectedStoreTopicForName,
  normalizeStoreNameForMatch,
  resolveStoreTopicConfig,
  type StoreTopicConfig,
  type StoreTopicResolution,
} from "@/lib/store-topic-config";
import { storeTopicRuleSeeds } from "@/lib/store-topic-rule-seeds";
import {
  commercePlatformLabel,
  parseCommercePlatform,
  type CommercePlatform,
} from "@/lib/result-source";

function asConfig(rule: {
  id: string;
  commercePlatform: string;
  storeName: string;
  normalizedStoreName: string;
  expectedTopic: string;
  enabled: boolean;
}): StoreTopicConfig {
  return {
    ...rule,
    commercePlatform: rule.commercePlatform as CommercePlatform,
  };
}

export async function ensureStoreTopicRuleSeeds() {
  await prisma.$transaction(
    storeTopicRuleSeeds.map((seed) => {
      const normalizedStoreName = normalizeStoreNameForMatch(seed.storeName);
      return prisma.storeTopicRule.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          commercePlatform: seed.commercePlatform,
          storeName: seed.storeName,
          normalizedStoreName,
          expectedTopic: expectedStoreTopicForName(seed.storeName),
          enabled: true,
        },
        update: {},
      });
    }),
  );
}

export async function loadActiveStoreTopicRules() {
  return (
    await prisma.storeTopicRule.findMany({
      where: { enabled: true, deletedAt: null },
      orderBy: [
        { commercePlatform: "asc" },
        { normalizedStoreName: "asc" },
      ],
    })
  ).map(asConfig);
}

export async function resolveStoreTopicRule(input: {
  storeName?: unknown;
  commercePlatform?: unknown;
}): Promise<StoreTopicResolution> {
  const rules = await loadActiveStoreTopicRules();
  return resolveStoreTopicConfig(rules, input);
}

export async function resolveStoreTopicAuditRequirement(input: {
  source?: unknown;
  channel?: unknown;
  platform?: unknown;
  storeName?: unknown;
  commercePlatform?: unknown;
  expectedStoreTopic?: unknown;
  storeMappingStatus?: unknown;
}) {
  if (
    String(input.source ?? "") !== "EXCEL" &&
    !String(input.storeName ?? "").trim() &&
    !String(input.expectedStoreTopic ?? "").trim()
  ) return null;
  const resolved = await resolveStoreTopicRule({
    storeName: input.storeName,
    commercePlatform: input.commercePlatform,
  });
  return buildStoreTopicAuditRequirement({ ...input, resolved });
}

export async function listStoreTopicRules(input: {
  commercePlatform?: unknown;
  query?: unknown;
  status?: unknown;
  page?: unknown;
  pageSize?: unknown;
}) {
  const commercePlatform = parseCommercePlatform(input.commercePlatform);
  const status = String(input.status ?? "ALL").trim().toUpperCase();
  const query = normalizeStoreNameForMatch(input.query);
  const page = Math.max(1, Number(input.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20));
  const rules = await prisma.storeTopicRule.findMany({
    where: {
      deletedAt: null,
      ...(commercePlatform ? { commercePlatform } : {}),
      ...(status === "ENABLED"
        ? { enabled: true }
        : status === "DISABLED"
          ? { enabled: false }
          : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  const filtered = query
    ? rules.filter((rule) =>
        normalizeStoreNameForMatch(rule.storeName).includes(query),
      )
    : rules;
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

function validatedRuleInput(input: {
  commercePlatform?: unknown;
  storeName?: unknown;
  enabled?: unknown;
}) {
  const commercePlatform = parseCommercePlatform(input.commercePlatform);
  const storeName = String(input.storeName ?? "").trim();
  if (!commercePlatform || !storeName) {
    throw new Error("成交平台和标准店铺名称为必填项。");
  }
  return {
    commercePlatform,
    storeName,
    normalizedStoreName: normalizeStoreNameForMatch(storeName),
    expectedTopic: expectedStoreTopicForName(storeName),
    enabled: input.enabled !== false,
  };
}

async function duplicateRule(
  commercePlatform: CommercePlatform,
  normalizedStoreName: string,
  excludeId?: string,
) {
  return prisma.storeTopicRule.findFirst({
    where: {
      commercePlatform,
      normalizedStoreName,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

function duplicateMessage(
  commercePlatform: CommercePlatform,
  existingStoreName: string,
) {
  return `${commercePlatformLabel(commercePlatform)}平台下已存在相同店铺：${existingStoreName}。`;
}

export async function createStoreTopicRule(
  input: { commercePlatform?: unknown; storeName?: unknown; enabled?: unknown },
  user: { id: string; role: string },
) {
  const data = validatedRuleInput(input);
  const duplicate = await duplicateRule(
    data.commercePlatform,
    data.normalizedStoreName,
  );
  if (duplicate) throw new Error(duplicateMessage(data.commercePlatform, duplicate.storeName));
  return prisma.$transaction(async (tx) => {
    const rule = await tx.storeTopicRule.create({
      data: { ...data, createdBy: user.id, updatedBy: user.id },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: rule.id,
        summary: `新增${commercePlatformLabel(data.commercePlatform)}店铺规则 ${rule.storeName}`,
        metadata: JSON.stringify({ role: user.role, afterStoreName: rule.storeName }),
      },
    });
    return rule;
  });
}

export async function updateStoreTopicRule(
  id: string,
  input: { commercePlatform?: unknown; storeName?: unknown; enabled?: unknown },
  user: { id: string; role: string },
) {
  const existing = await prisma.storeTopicRule.findFirst({
    where: { id, deletedAt: null },
  });
  if (!existing) throw new Error("店铺规则不存在或已删除。");
  const data = validatedRuleInput(input);
  const duplicate = await duplicateRule(
    data.commercePlatform,
    data.normalizedStoreName,
    id,
  );
  if (duplicate) throw new Error(duplicateMessage(data.commercePlatform, duplicate.storeName));
  return prisma.$transaction(async (tx) => {
    const rule = await tx.storeTopicRule.update({
      where: { id },
      data: { ...data, updatedBy: user.id },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "UPDATE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: rule.id,
        summary: `更新店铺规则 ${existing.storeName} → ${rule.storeName}`,
        metadata: JSON.stringify({
          role: user.role,
          beforeStoreName: existing.storeName,
          afterStoreName: rule.storeName,
          beforeEnabled: existing.enabled,
          afterEnabled: rule.enabled,
        }),
      },
    });
    return rule;
  });
}

export async function deleteStoreTopicRule(
  id: string,
  user: { id: string; role: string },
) {
  const existing = await prisma.storeTopicRule.findFirst({
    where: { id, deletedAt: null },
  });
  if (!existing) throw new Error("店铺规则不存在或已删除。");
  return prisma.$transaction(async (tx) => {
    const rule = await tx.storeTopicRule.update({
      where: { id },
      data: { enabled: false, deletedAt: new Date(), updatedBy: user.id },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "DELETE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: rule.id,
        summary: `删除${commercePlatformLabel(existing.commercePlatform)}店铺规则 ${existing.storeName}`,
        metadata: JSON.stringify({ role: user.role, retainedAuditResults: true }),
      },
    });
    return rule;
  });
}

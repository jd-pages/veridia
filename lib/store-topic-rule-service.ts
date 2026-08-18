import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  buildStoreTopicAuditRequirement,
  expectedStoreTopicForName,
  normalizeStoreNameForMatch,
  normalizeStoreTopicForMatch,
  resolveStoreTopicConfig,
  storeTopicWithHash,
  type StoreAliasConfig,
  type StoreAcceptedTopicConfig,
  type StoreTopicConfig,
  type StoreTopicResolution,
} from "@/lib/store-topic-config";
import {
  storeAcceptedTopicSeeds,
  storeRequiredTopicSeeds,
  storeTopicRuleSeeds,
} from "@/lib/store-topic-rule-seeds";
import {
  commercePlatformLabel,
  parseCommercePlatform,
  type CommercePlatform,
} from "@/lib/result-source";

export type StoreTopicEntryType = "ACCEPTED" | "REQUIRED";
type StoredStoreTopicEntryType = StoreTopicEntryType | "ACCEPTED_ALIAS";

interface TopicInput {
  id?: unknown;
  topic?: unknown;
  enabled?: unknown;
}

interface StoreTopicRuleInput {
  commercePlatform?: unknown;
  storeName?: unknown;
  enabled?: unknown;
  acceptedTopics?: unknown;
  requiredTopics?: unknown;
}

interface ValidatedTopic {
  id?: string;
  topic: string;
  normalizedTopic: string;
  enabled: boolean;
  topicType: StoreTopicEntryType;
}

interface TopicEntryRecord extends StoreAcceptedTopicConfig {
  topicType: string;
  deletedAt: Date | null;
}

const forbiddenTopicSeparators = /[,，、;；/|｜\r\n]/u;
const MAX_STORE_TOPIC_LENGTH = 100;

function activeTopicSnapshot(
  topics: readonly TopicEntryRecord[],
  topicType: StoreTopicEntryType,
) {
  return topics
    .filter(
      (topic) =>
        (topic.topicType === topicType ||
          (topicType === "ACCEPTED" &&
            topic.topicType === "ACCEPTED_ALIAS")) &&
        topic.deletedAt === null,
    )
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((topic) => ({
      id: topic.id,
      topic: topic.topic,
      normalizedTopic: topic.normalizedTopic,
      sortOrder: topic.sortOrder,
      enabled: topic.enabled,
    }));
}

function activeStoreAliases(input: {
  id: string;
  storeName: string;
  normalizedStoreName: string;
  enabled: boolean;
  topicEntries: readonly TopicEntryRecord[];
}): StoreAliasConfig[] {
  return [
    {
      id: `${input.id}-canonical-alias`,
      alias: input.storeName,
      normalizedAlias: input.normalizedStoreName,
      enabled: input.enabled,
    },
    ...input.topicEntries
      .filter(
        (topic) =>
          topic.topicType === "ACCEPTED_ALIAS" && topic.deletedAt === null,
      )
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((topic) => ({
        id: topic.id,
        alias: topic.topic.replace(/^#/u, ""),
        normalizedAlias: topic.normalizedTopic,
        enabled: topic.enabled,
      })),
  ];
}

function withTopicGroups<
  T extends {
    id: string;
    storeName: string;
    normalizedStoreName: string;
    enabled: boolean;
    topicEntries: TopicEntryRecord[];
  },
>(
  rule: T,
) {
  const { topicEntries, ...identity } = rule;
  return {
    ...identity,
    aliases: activeStoreAliases(rule),
    acceptedTopics: activeTopicSnapshot(topicEntries, "ACCEPTED"),
    requiredTopics: activeTopicSnapshot(topicEntries, "REQUIRED"),
  };
}

function asConfig(rule: {
  id: string;
  commercePlatform: string;
  storeName: string;
  normalizedStoreName: string;
  expectedTopic: string;
  enabled: boolean;
  topicEntries: TopicEntryRecord[];
}): StoreTopicConfig {
  return {
    ...withTopicGroups(rule),
    commercePlatform: rule.commercePlatform as CommercePlatform,
  };
}

function validateTopicList(input: {
  value: unknown;
  topicType: StoreTopicEntryType;
  allowEmpty: boolean;
  defaultTopic?: string;
}) {
  const rawTopics = input.value === undefined
    ? input.defaultTopic
      ? [{ topic: input.defaultTopic }]
      : []
    : input.value;
  if (!Array.isArray(rawTopics)) {
    throw new Error("店铺话题必须使用结构化数组提交。");
  }
  if (!input.allowEmpty && rawTopics.length === 0) {
    throw new Error("至少需要配置一条可接受店铺话题。");
  }
  const label = input.topicType === "ACCEPTED" ? "可接受店铺话题" : "附加必需话题";
  const topics: ValidatedTopic[] = rawTopics.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`第 ${index + 1} 条${label}格式不正确。`);
    }
    const item = raw as TopicInput;
    const topic = storeTopicWithHash(item.topic);
    const text = topic.slice(1);
    if (!text) throw new Error(`第 ${index + 1} 条${label}不能为空。`);
    if (text.length > MAX_STORE_TOPIC_LENGTH) {
      throw new Error(`第 ${index + 1} 条${label}不能超过 ${MAX_STORE_TOPIC_LENGTH} 个字符。`);
    }
    if (forbiddenTopicSeparators.test(text)) {
      throw new Error(
        `第 ${index + 1} 条${label}只能填写一条完整话题，请使用添加按钮新增其他话题。`,
      );
    }
    return {
      id: String(item.id ?? "").trim() || undefined,
      topic,
      normalizedTopic: normalizeStoreTopicForMatch(topic),
      enabled: item.enabled !== false,
      topicType: input.topicType,
    };
  });
  const seen = new Map<string, string>();
  for (const topic of topics) {
    const existing = seen.get(topic.normalizedTopic);
    if (existing) throw new Error(`该店铺已存在相同话题：${existing}`);
    seen.set(topic.normalizedTopic, topic.topic);
  }
  return topics;
}

export function validateAcceptedStoreTopics(
  value: unknown,
  defaultStoreName?: string,
) {
  return validateTopicList({
    value,
    topicType: "ACCEPTED",
    allowEmpty: false,
    defaultTopic: defaultStoreName,
  });
}

export function validateStoreTopicGroups(input: {
  acceptedTopics: unknown;
  requiredTopics: unknown;
  defaultStoreName?: string;
}) {
  const acceptedTopics = validateAcceptedStoreTopics(
    input.acceptedTopics,
    input.defaultStoreName,
  );
  const requiredTopics = validateTopicList({
    value: input.requiredTopics,
    topicType: "REQUIRED",
    allowEmpty: true,
  });
  const acceptedKeys = new Map(
    acceptedTopics.map((topic) => [topic.normalizedTopic, topic.topic]),
  );
  for (const topic of requiredTopics) {
    const duplicate = acceptedKeys.get(topic.normalizedTopic);
    if (duplicate) {
      throw new Error(`同一话题不能同时设为可接受和附加必需话题：${duplicate}`);
    }
  }
  return { acceptedTopics, requiredTopics };
}

export async function ensureStoreTopicRuleSeeds() {
  await prisma.$transaction(async (tx) => {
    for (const seed of storeTopicRuleSeeds) {
      const normalizedStoreName = normalizeStoreNameForMatch(seed.storeName);
      const expectedTopic = expectedStoreTopicForName(seed.storeName);
      const rule = await tx.storeTopicRule.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          commercePlatform: seed.commercePlatform,
          storeName: seed.storeName,
          normalizedStoreName,
          expectedTopic,
          enabled: true,
        },
        update: {},
      });
      await tx.storeTopicEntry.upsert({
        where: {
          storeTopicRuleId_normalizedTopic: {
            storeTopicRuleId: rule.id,
            normalizedTopic: normalizeStoreTopicForMatch(expectedTopic),
          },
        },
        create: {
          storeTopicRuleId: rule.id,
          topic: expectedTopic,
          normalizedTopic: normalizeStoreTopicForMatch(expectedTopic),
          topicType: "ACCEPTED",
          sortOrder: 0,
          enabled: true,
        },
        update: {},
      });
    }
    for (const seed of storeAcceptedTopicSeeds) {
      const rule = await tx.storeTopicRule.findUnique({
        where: {
          commercePlatform_normalizedStoreName: {
            commercePlatform: seed.commercePlatform,
            normalizedStoreName: normalizeStoreNameForMatch(seed.storeName),
          },
        },
      });
      if (!rule) continue;
      const normalizedTopic = normalizeStoreTopicForMatch(seed.topic);
      await tx.storeTopicEntry.upsert({
        where: {
          storeTopicRuleId_normalizedTopic: {
            storeTopicRuleId: rule.id,
            normalizedTopic,
          },
        },
        create: {
          storeTopicRuleId: rule.id,
          topic: storeTopicWithHash(seed.topic),
          normalizedTopic,
          topicType: seed.isStoreAlias ? "ACCEPTED_ALIAS" : "ACCEPTED",
          sortOrder: 1,
          enabled: true,
        },
        update: {
          topicType: seed.isStoreAlias ? "ACCEPTED_ALIAS" : "ACCEPTED",
          enabled: true,
          deletedAt: null,
        },
      });
    }
    for (const seed of storeRequiredTopicSeeds) {
      const rule = await tx.storeTopicRule.findUnique({
        where: {
          commercePlatform_normalizedStoreName: {
            commercePlatform: seed.commercePlatform,
            normalizedStoreName: normalizeStoreNameForMatch(seed.storeName),
          },
        },
      });
      if (!rule) continue;
      const normalizedTopic = normalizeStoreTopicForMatch(seed.topic);
      await tx.storeTopicEntry.upsert({
        where: {
          storeTopicRuleId_normalizedTopic: {
            storeTopicRuleId: rule.id,
            normalizedTopic,
          },
        },
        create: {
          storeTopicRuleId: rule.id,
          topic: storeTopicWithHash(seed.topic),
          normalizedTopic,
          topicType: "REQUIRED",
          sortOrder: 0,
          enabled: true,
        },
        update: {},
      });
    }
  });
}

export async function loadActiveStoreTopicRules() {
  return (
    await prisma.storeTopicRule.findMany({
      where: { enabled: true, deletedAt: null },
      include: {
        topicEntries: {
          where: { enabled: true, deletedAt: null },
          orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }],
        },
      },
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
  return resolveStoreTopicConfig(await loadActiveStoreTopicRules(), input);
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
  const resolved = await resolveStoreTopicRule(input);
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
    include: {
      topicEntries: {
        where: { deletedAt: null },
        orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }],
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  const filtered = query
    ? rules.filter((rule) =>
        normalizeStoreNameForMatch(rule.storeName).includes(query),
      )
    : rules;
  return {
    items: filtered
      .slice((page - 1) * pageSize, page * pageSize)
      .map(withTopicGroups),
    total: filtered.length,
    page,
    pageSize,
  };
}

function validatedRuleIdentity(input: StoreTopicRuleInput) {
  const commercePlatform = parseCommercePlatform(input.commercePlatform);
  const storeName = String(input.storeName ?? "").trim();
  if (!commercePlatform || !storeName) {
    throw new Error("成交平台和标准店铺名称为必填项。");
  }
  return {
    commercePlatform,
    storeName,
    normalizedStoreName: normalizeStoreNameForMatch(storeName),
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

async function replaceTopicEntries(
  tx: Prisma.TransactionClient,
  storeTopicRuleId: string,
  topics: ValidatedTopic[],
  existingTopics: Array<{
    id: string;
    normalizedTopic: string;
    topicType: string;
  }>,
  userId: string,
) {
  const retainedIds = new Set<string>();
  for (const topicType of ["ACCEPTED", "REQUIRED"] as const) {
    const group = topics.filter((topic) => topic.topicType === topicType);
    for (const [sortOrder, topic] of group.entries()) {
      const existing =
        existingTopics.find(
          (candidate) => candidate.normalizedTopic === topic.normalizedTopic,
        ) || existingTopics.find((candidate) => candidate.id === topic.id);
      if (existing) {
        retainedIds.add(existing.id);
        const storedTopicType: StoredStoreTopicEntryType =
          topicType === "ACCEPTED" &&
          existing.topicType === "ACCEPTED_ALIAS"
            ? "ACCEPTED_ALIAS"
            : topicType;
        await tx.storeTopicEntry.update({
          where: { id: existing.id },
          data: {
            topic: topic.topic,
            normalizedTopic: topic.normalizedTopic,
            topicType: storedTopicType,
            sortOrder,
            enabled: topic.enabled,
            deletedAt: null,
            updatedBy: userId,
          },
        });
      } else {
        const created = await tx.storeTopicEntry.create({
          data: {
            storeTopicRuleId,
            topic: topic.topic,
            normalizedTopic: topic.normalizedTopic,
            topicType,
            sortOrder,
            enabled: topic.enabled,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        retainedIds.add(created.id);
      }
    }
  }
  await tx.storeTopicEntry.updateMany({
    where: {
      storeTopicRuleId,
      id: { notIn: [...retainedIds] },
      deletedAt: null,
    },
    data: { enabled: false, deletedAt: new Date(), updatedBy: userId },
  });
}

function topicLogSnapshot(topics: readonly ValidatedTopic[]) {
  return topics.map(({ topic, topicType, enabled }, sortOrder) => ({
    topic,
    topicType,
    enabled,
    sortOrder,
  }));
}

export async function createStoreTopicRule(
  input: StoreTopicRuleInput,
  user: { id: string; role: string },
) {
  const identity = validatedRuleIdentity(input);
  const groups = validateStoreTopicGroups({
    acceptedTopics: input.acceptedTopics,
    requiredTopics: input.requiredTopics,
    defaultStoreName: identity.storeName,
  });
  const topics = [...groups.acceptedTopics, ...groups.requiredTopics];
  const duplicate = await duplicateRule(
    identity.commercePlatform,
    identity.normalizedStoreName,
  );
  if (duplicate) {
    throw new Error(
      duplicateMessage(identity.commercePlatform, duplicate.storeName),
    );
  }
  return prisma.$transaction(async (tx) => {
    const rule = await tx.storeTopicRule.create({
      data: {
        ...identity,
        expectedTopic: groups.acceptedTopics[0].topic,
        createdBy: user.id,
        updatedBy: user.id,
      },
    });
    await replaceTopicEntries(tx, rule.id, topics, [], user.id);
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: rule.id,
        summary: `新增${commercePlatformLabel(identity.commercePlatform)}店铺规则 ${rule.storeName}`,
        metadata: JSON.stringify({
          role: user.role,
          commercePlatform: identity.commercePlatform,
          storeName: rule.storeName,
          beforeTopics: [],
          afterTopics: topicLogSnapshot(topics),
        }),
      },
    });
    const created = await tx.storeTopicRule.findUniqueOrThrow({
      where: { id: rule.id },
      include: {
        topicEntries: {
          where: { deletedAt: null },
          orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }],
        },
      },
    });
    return withTopicGroups(created);
  });
}

export async function updateStoreTopicRule(
  id: string,
  input: StoreTopicRuleInput,
  user: { id: string; role: string },
) {
  const existing = await prisma.storeTopicRule.findFirst({
    where: { id, deletedAt: null },
    include: {
      topicEntries: { orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }] },
    },
  });
  if (!existing) throw new Error("店铺规则不存在或已删除。");
  const identity = validatedRuleIdentity(input);
  const duplicate = await duplicateRule(
    identity.commercePlatform,
    identity.normalizedStoreName,
    id,
  );
  if (duplicate) {
    throw new Error(
      duplicateMessage(identity.commercePlatform, duplicate.storeName),
    );
  }
  const beforeAccepted = activeTopicSnapshot(existing.topicEntries, "ACCEPTED");
  const beforeRequired = activeTopicSnapshot(existing.topicEntries, "REQUIRED");
  const groups = validateStoreTopicGroups({
    acceptedTopics:
      input.acceptedTopics === undefined
        ? beforeAccepted.length
          ? beforeAccepted
          : [{ topic: existing.expectedTopic, enabled: true }]
        : input.acceptedTopics,
    requiredTopics:
      input.requiredTopics === undefined ? beforeRequired : input.requiredTopics,
  });
  if (
    groups.acceptedTopics[0] &&
    normalizeStoreTopicForMatch(groups.acceptedTopics[0].topic) ===
      normalizeStoreTopicForMatch(existing.storeName) &&
    identity.storeName !== existing.storeName
  ) {
    groups.acceptedTopics[0] = {
      ...groups.acceptedTopics[0],
      topic: expectedStoreTopicForName(identity.storeName),
      normalizedTopic: normalizeStoreTopicForMatch(identity.storeName),
    };
    validateStoreTopicGroups({
      acceptedTopics: groups.acceptedTopics,
      requiredTopics: groups.requiredTopics,
    });
  }
  const topics = [...groups.acceptedTopics, ...groups.requiredTopics];
  return prisma.$transaction(async (tx) => {
    const rule = await tx.storeTopicRule.update({
      where: { id },
      data: {
        ...identity,
        expectedTopic: groups.acceptedTopics[0].topic,
        updatedBy: user.id,
      },
    });
    await replaceTopicEntries(tx, id, topics, existing.topicEntries, user.id);
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "UPDATE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: rule.id,
        summary: `更新店铺规则 ${existing.storeName} → ${rule.storeName}`,
        metadata: JSON.stringify({
          role: user.role,
          commercePlatform: identity.commercePlatform,
          beforeStoreName: existing.storeName,
          afterStoreName: rule.storeName,
          beforeEnabled: existing.enabled,
          afterEnabled: rule.enabled,
          beforeTopics: topicLogSnapshot([
            ...beforeAccepted.map((topic) => ({ ...topic, topicType: "ACCEPTED" as const })),
            ...beforeRequired.map((topic) => ({ ...topic, topicType: "REQUIRED" as const })),
          ]),
          afterTopics: topicLogSnapshot(topics),
        }),
      },
    });
    const updated = await tx.storeTopicRule.findUniqueOrThrow({
      where: { id },
      include: {
        topicEntries: {
          where: { deletedAt: null },
          orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }],
        },
      },
    });
    return withTopicGroups(updated);
  });
}

export async function deleteStoreTopicRule(
  id: string,
  user: { id: string; role: string },
) {
  const existing = await prisma.storeTopicRule.findFirst({
    where: { id, deletedAt: null },
    include: {
      topicEntries: { orderBy: [{ topicType: "asc" }, { sortOrder: "asc" }] },
    },
  });
  if (!existing) throw new Error("店铺规则不存在或已删除。");
  return prisma.$transaction(async (tx) => {
    const deletedAt = new Date();
    const rule = await tx.storeTopicRule.update({
      where: { id },
      data: { enabled: false, deletedAt, updatedBy: user.id },
    });
    await tx.storeTopicEntry.updateMany({
      where: { storeTopicRuleId: id, deletedAt: null },
      data: { enabled: false, deletedAt, updatedBy: user.id },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "DELETE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: rule.id,
        summary: `删除${commercePlatformLabel(existing.commercePlatform)}店铺规则 ${existing.storeName}`,
        metadata: JSON.stringify({
          role: user.role,
          commercePlatform: existing.commercePlatform,
          storeName: existing.storeName,
          beforeTopics: existing.topicEntries.map((topic) => ({
            topic: topic.topic,
            topicType: topic.topicType,
            enabled: topic.enabled,
            sortOrder: topic.sortOrder,
          })),
          afterTopics: [],
          retainedAuditResults: true,
        }),
      },
    });
    return rule;
  });
}

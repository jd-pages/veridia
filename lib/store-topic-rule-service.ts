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
  storeNameAliasSeeds,
  storeRequiredTopicSeeds,
  storeTopicRuleSeeds,
  validateStoreNameAliasSeeds,
} from "@/lib/store-topic-rule-seeds";
import {
  commercePlatformLabel,
  parseCommercePlatform,
  type CommercePlatform,
} from "@/lib/result-source";

export type StoreTopicEntryType = "ACCEPTED" | "REQUIRED";
type StoredStoreTopicEntryType =
  | StoreTopicEntryType
  | "ACCEPTED_ALIAS"
  | "STORE_ALIAS";

interface TopicInput {
  id?: unknown;
  topic?: unknown;
  enabled?: unknown;
}

interface StoreAliasInput {
  id?: unknown;
  alias?: unknown;
  enabled?: unknown;
}

interface StoreTopicRuleInput {
  commercePlatform?: unknown;
  storeName?: unknown;
  enabled?: unknown;
  acceptedTopics?: unknown;
  requiredTopics?: unknown;
  storeAliases?: unknown;
}

interface ValidatedTopic {
  id?: string;
  topic: string;
  normalizedTopic: string;
  enabled: boolean;
  topicType: StoreTopicEntryType;
}

export interface ValidatedStoreAlias {
  id?: string;
  alias: string;
  normalizedAlias: string;
  enabled: boolean;
  sortOrder: number;
}

interface TopicEntryRecord extends StoreAcceptedTopicConfig {
  topicType: string;
  deletedAt: Date | null;
}

const forbiddenTopicSeparators = /[,，、;；/|｜\r\n]/u;
const MAX_STORE_TOPIC_LENGTH = 100;
const MAX_STORE_ALIAS_LENGTH = 100;

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
          ["ACCEPTED_ALIAS", "STORE_ALIAS"].includes(topic.topicType) &&
          topic.deletedAt === null,
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

function managedStoreAliases(topics: readonly TopicEntryRecord[]) {
  return topics
    .filter(
      (topic) => topic.topicType === "STORE_ALIAS" && topic.deletedAt === null,
    )
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((topic) => ({
      id: topic.id,
      alias: topic.topic,
      normalizedAlias: topic.normalizedTopic,
      enabled: topic.enabled,
      sortOrder: topic.sortOrder,
    }));
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
    storeAliases: managedStoreAliases(topicEntries),
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
    allowEmpty: true,
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

export function validateStoreAliases(
  value: unknown,
  canonicalStoreName: unknown,
): ValidatedStoreAlias[] {
  if (!Array.isArray(value)) {
    throw new Error("导入别名必须使用结构化数组提交。");
  }
  const normalizedCanonical = normalizeStoreNameForMatch(canonicalStoreName);
  const seen = new Map<string, string>();
  return value.map((raw, sortOrder) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`第 ${sortOrder + 1} 条导入别名格式不正确。`);
    }
    const item = raw as StoreAliasInput;
    const alias = String(item.alias ?? "").trim();
    if (!alias) throw new Error(`第 ${sortOrder + 1} 条导入别名不能为空。`);
    if (alias.length > MAX_STORE_ALIAS_LENGTH) {
      throw new Error(
        `第 ${sortOrder + 1} 条导入别名不能超过 ${MAX_STORE_ALIAS_LENGTH} 个字符。`,
      );
    }
    const normalizedAlias = normalizeStoreNameForMatch(alias);
    if (normalizedAlias === normalizedCanonical) {
      throw new Error(
        "该名称已经是标准店铺名称，无需重复添加为导入别名。",
      );
    }
    const duplicate = seen.get(normalizedAlias);
    if (duplicate) {
      throw new Error(`该店铺已存在相同导入别名：${duplicate}。`);
    }
    seen.set(normalizedAlias, alias);
    return {
      id: String(item.id ?? "").trim() || undefined,
      alias,
      normalizedAlias,
      enabled: item.enabled !== false,
      sortOrder,
    };
  });
}

export async function ensureStoreTopicRuleSeeds() {
  validateStoreNameAliasSeeds();
  await prisma.$transaction(async (tx) => {
    for (const seed of storeTopicRuleSeeds) {
      const normalizedStoreName = normalizeStoreNameForMatch(seed.storeName);
      const expectedTopic = expectedStoreTopicForName(seed.storeName);
      const acceptedTopics = seed.acceptedTopics ?? [expectedTopic];
      const rule = await tx.storeTopicRule.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          commercePlatform: seed.commercePlatform,
          storeName: seed.storeName,
          normalizedStoreName,
          expectedTopic: acceptedTopics[0] || "",
          enabled: true,
        },
        update:
          seed.acceptedTopics === undefined
            ? {}
            : { expectedTopic: acceptedTopics[0] || "" },
      });
      if (seed.acceptedTopics !== undefined) {
        await tx.storeTopicEntry.updateMany({
          where: {
            storeTopicRuleId: rule.id,
            topicType: { in: ["ACCEPTED", "ACCEPTED_ALIAS", "REQUIRED"] },
            deletedAt: null,
          },
          data: { enabled: false, deletedAt: new Date() },
        });
      }
      for (const [sortOrder, topic] of acceptedTopics.entries()) {
        await tx.storeTopicEntry.upsert({
          where: {
            storeTopicRuleId_normalizedTopic: {
              storeTopicRuleId: rule.id,
              normalizedTopic: normalizeStoreTopicForMatch(topic),
            },
          },
          create: {
            storeTopicRuleId: rule.id,
            topic,
            normalizedTopic: normalizeStoreTopicForMatch(topic),
            topicType: "ACCEPTED",
            sortOrder,
            enabled: true,
          },
          update: {
            topic,
            topicType: "ACCEPTED",
            sortOrder,
            enabled: true,
            deletedAt: null,
          },
        });
      }
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
    for (const seed of storeNameAliasSeeds) {
      const rule = await tx.storeTopicRule.findUnique({
        where: {
          commercePlatform_normalizedStoreName: {
            commercePlatform: seed.commercePlatform,
            normalizedStoreName: normalizeStoreNameForMatch(
              seed.canonicalStoreName,
            ),
          },
        },
      });
      if (!rule) {
        throw new Error(
          `CANONICAL_STORE_NOT_FOUND：${seed.commercePlatform} / ${seed.canonicalStoreName}`,
        );
      }
      const normalizedAlias = normalizeStoreNameForMatch(seed.alias);
      const canonicalCollision = await tx.storeTopicRule.findFirst({
        where: {
          commercePlatform: seed.commercePlatform,
          normalizedStoreName: normalizedAlias,
          id: { not: rule.id },
          deletedAt: null,
        },
      });
      const aliasCollision = await tx.storeTopicEntry.findFirst({
        where: {
          normalizedTopic: normalizedAlias,
          topicType: { in: ["ACCEPTED_ALIAS", "STORE_ALIAS"] },
          enabled: true,
          deletedAt: null,
          storeTopicRuleId: { not: rule.id },
          storeTopicRule: {
            commercePlatform: seed.commercePlatform,
            deletedAt: null,
          },
        },
        include: { storeTopicRule: true },
      });
      if (canonicalCollision || aliasCollision) {
        throw new Error(
          `STORE_ALIAS_COLLISION：${seed.commercePlatform} / ${seed.alias}`,
        );
      }
      const occupiedEntry = await tx.storeTopicEntry.findUnique({
        where: {
          storeTopicRuleId_normalizedTopic: {
            storeTopicRuleId: rule.id,
            normalizedTopic: normalizedAlias,
          },
        },
      });
      if (occupiedEntry && occupiedEntry.topicType !== "STORE_ALIAS") {
        throw new Error(
          `STORE_ALIAS_COLLISION：${seed.commercePlatform} / ${seed.alias}`,
        );
      }
      await tx.storeTopicEntry.upsert({
        where: {
          storeTopicRuleId_normalizedTopic: {
            storeTopicRuleId: rule.id,
            normalizedTopic: normalizedAlias,
          },
        },
        create: {
          storeTopicRuleId: rule.id,
          topic: seed.alias,
          normalizedTopic: normalizedAlias,
          topicType: "STORE_ALIAS",
          sortOrder: 0,
          enabled: true,
        },
        update: {
          topic: seed.alias,
          topicType: "STORE_ALIAS",
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
    ? rules.filter(
        (rule) =>
          normalizeStoreNameForMatch(rule.storeName).includes(query) ||
          managedStoreAliases(rule.topicEntries).some((alias) =>
            alias.normalizedAlias.includes(query),
          ),
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
  const retainedIds = new Set(
    existingTopics
      .filter((topic) => topic.topicType === "STORE_ALIAS")
      .map((topic) => topic.id),
  );
  for (const topicType of ["ACCEPTED", "REQUIRED"] as const) {
    const group = topics.filter((topic) => topic.topicType === topicType);
    for (const [sortOrder, topic] of group.entries()) {
      const existing =
        existingTopics.find(
          (candidate) =>
            candidate.topicType !== "STORE_ALIAS" &&
            candidate.normalizedTopic === topic.normalizedTopic,
        ) || existingTopics.find(
          (candidate) =>
            candidate.topicType !== "STORE_ALIAS" && candidate.id === topic.id,
        );
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

async function assertStoreAliasesAvailable(
  tx: Prisma.TransactionClient,
  input: {
    storeTopicRuleId: string;
    commercePlatform: CommercePlatform;
    aliases: readonly ValidatedStoreAlias[];
  },
) {
  if (input.aliases.length === 0) return;
  const normalizedAliases = input.aliases.map((alias) => alias.normalizedAlias);
  const currentRuleTopicCollision = await tx.storeTopicEntry.findFirst({
    where: {
      storeTopicRuleId: input.storeTopicRuleId,
      normalizedTopic: { in: normalizedAliases },
      topicType: { not: "STORE_ALIAS" },
      deletedAt: null,
    },
  });
  if (currentRuleTopicCollision) {
    const alias = input.aliases.find(
      (item) => item.normalizedAlias === currentRuleTopicCollision.normalizedTopic,
    )!;
    throw new Error(
      `STORE_ALIAS_COLLISION：该导入别名已由当前店铺的话题或历史兼容名称使用：${alias.alias}。`,
    );
  }
  const canonicalCollision = await tx.storeTopicRule.findFirst({
    where: {
      commercePlatform: input.commercePlatform,
      normalizedStoreName: { in: normalizedAliases },
      id: { not: input.storeTopicRuleId },
      deletedAt: null,
    },
  });
  if (canonicalCollision) {
    const alias = input.aliases.find(
      (item) => item.normalizedAlias === canonicalCollision.normalizedStoreName,
    )!;
    throw new Error(
      `STORE_ALIAS_COLLISION：该导入别名已被本平台其他标准店铺使用：${alias.alias}（${canonicalCollision.storeName}）。`,
    );
  }
  const aliasCollision = await tx.storeTopicEntry.findFirst({
    where: {
      normalizedTopic: { in: normalizedAliases },
      topicType: { in: ["STORE_ALIAS", "ACCEPTED_ALIAS"] },
      deletedAt: null,
      storeTopicRuleId: { not: input.storeTopicRuleId },
      storeTopicRule: {
        commercePlatform: input.commercePlatform,
        deletedAt: null,
      },
    },
    include: { storeTopicRule: true },
  });
  if (aliasCollision) {
    const alias = input.aliases.find(
      (item) => item.normalizedAlias === aliasCollision.normalizedTopic,
    )!;
    throw new Error(
      `STORE_ALIAS_COLLISION：该导入别名已被本平台其他标准店铺使用：${alias.alias}（${aliasCollision.storeTopicRule.storeName}）。`,
    );
  }
}

async function replaceStoreAliases(
  tx: Prisma.TransactionClient,
  input: {
    storeTopicRuleId: string;
    commercePlatform: CommercePlatform;
    aliases: readonly ValidatedStoreAlias[];
    existingTopics: Array<{
      id: string;
      normalizedTopic: string;
      topicType: string;
    }>;
    userId: string;
  },
) {
  await assertStoreAliasesAvailable(tx, input);
  const existingAliases = input.existingTopics.filter(
    (topic) => topic.topicType === "STORE_ALIAS",
  );
  const retainedIds = new Set<string>();
  for (const alias of input.aliases) {
    const existing =
      existingAliases.find(
        (candidate) => candidate.normalizedTopic === alias.normalizedAlias,
      ) || existingAliases.find((candidate) => candidate.id === alias.id);
    if (existing) {
      retainedIds.add(existing.id);
      await tx.storeTopicEntry.update({
        where: { id: existing.id },
        data: {
          topic: alias.alias,
          normalizedTopic: alias.normalizedAlias,
          topicType: "STORE_ALIAS",
          sortOrder: alias.sortOrder,
          enabled: alias.enabled,
          deletedAt: null,
          updatedBy: input.userId,
        },
      });
    } else {
      const created = await tx.storeTopicEntry.create({
        data: {
          storeTopicRuleId: input.storeTopicRuleId,
          topic: alias.alias,
          normalizedTopic: alias.normalizedAlias,
          topicType: "STORE_ALIAS",
          sortOrder: alias.sortOrder,
          enabled: alias.enabled,
          createdBy: input.userId,
          updatedBy: input.userId,
        },
      });
      retainedIds.add(created.id);
    }
  }
  await tx.storeTopicEntry.updateMany({
    where: {
      storeTopicRuleId: input.storeTopicRuleId,
      topicType: "STORE_ALIAS",
      deletedAt: null,
      ...(retainedIds.size > 0 ? { id: { notIn: [...retainedIds] } } : {}),
    },
    data: {
      enabled: false,
      deletedAt: new Date(),
      updatedBy: input.userId,
    },
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

function storeAliasLogSnapshot(aliases: readonly ValidatedStoreAlias[]) {
  return aliases.map(({ alias, enabled }, sortOrder) => ({
    alias,
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
  const storeAliases = validateStoreAliases(
    input.storeAliases === undefined ? [] : input.storeAliases,
    identity.storeName,
  );
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
        expectedTopic: groups.acceptedTopics[0]?.topic || "",
        createdBy: user.id,
        updatedBy: user.id,
      },
    });
    await replaceTopicEntries(tx, rule.id, topics, [], user.id);
    await replaceStoreAliases(tx, {
      storeTopicRuleId: rule.id,
      commercePlatform: identity.commercePlatform,
      aliases: storeAliases,
      existingTopics: [],
      userId: user.id,
    });
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
          beforeStoreAliases: [],
          afterStoreAliases: storeAliasLogSnapshot(storeAliases),
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
  const beforeStoreAliases = managedStoreAliases(existing.topicEntries);
  const groups = validateStoreTopicGroups({
    acceptedTopics:
      input.acceptedTopics === undefined
        ? beforeAccepted
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
  const storeAliases = validateStoreAliases(
    input.storeAliases === undefined ? beforeStoreAliases : input.storeAliases,
    identity.storeName,
  );
  return prisma.$transaction(async (tx) => {
    const rule = await tx.storeTopicRule.update({
      where: { id },
      data: {
        ...identity,
        expectedTopic: groups.acceptedTopics[0]?.topic || "",
        updatedBy: user.id,
      },
    });
    await replaceTopicEntries(tx, id, topics, existing.topicEntries, user.id);
    if (input.storeAliases !== undefined) {
      await replaceStoreAliases(tx, {
        storeTopicRuleId: id,
        commercePlatform: identity.commercePlatform,
        aliases: storeAliases,
        existingTopics: existing.topicEntries,
        userId: user.id,
      });
    } else {
      await assertStoreAliasesAvailable(tx, {
        storeTopicRuleId: id,
        commercePlatform: identity.commercePlatform,
        aliases: storeAliases,
      });
    }
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
          beforeStoreAliases: storeAliasLogSnapshot(beforeStoreAliases),
          afterStoreAliases: storeAliasLogSnapshot(storeAliases),
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

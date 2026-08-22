import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  normalizeStoreNameForMatch,
  normalizeStoreTopicForMatch,
  resolveStoreTopicConfig,
  storeTopicWithHash,
  type StoreTopicConfig,
} from "@/lib/store-topic-config";
import { storeNameAliasSeeds } from "@/lib/store-topic-rule-seeds";
import {
  applyRulePayload,
  exportCurrentRulePayload,
  storeTopicRuleStableKey,
  validateRulePayload,
} from "@/lib/rules/package";
import builtinRules from "@/rules/default-rules.json";
import { removeTemporaryDirectoryWithRetry } from "@/tests/helpers/remove-temporary-directory";

const root = process.cwd();
let temporaryRoot = "";
let sourceClient: PrismaClient;
let targetClient: PrismaClient;

function databaseUrl(databasePath: string) {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

async function createStoreRule(
  client: PrismaClient,
  input: {
    commercePlatform: "JD" | "TMALL" | "TAOBAO" | "DOUYIN_ECOMMERCE";
    storeName: string;
    storeAliases?: string[];
    acceptedTopic?: boolean;
    acceptedAlias?: string;
    requiredTopic?: string;
  },
) {
  const normalizedStoreName = normalizeStoreNameForMatch(input.storeName);
  const acceptedTopic = storeTopicWithHash(input.storeName);
  const acceptsCanonicalTopic = input.acceptedTopic !== false;
  const rule = await client.storeTopicRule.create({
    data: {
      commercePlatform: input.commercePlatform,
      storeName: input.storeName,
      normalizedStoreName,
      expectedTopic: acceptsCanonicalTopic ? acceptedTopic : "",
      enabled: true,
    },
  });
  const entries = [
    ...(acceptsCanonicalTopic
      ? [{
          topic: acceptedTopic,
          normalizedTopic: normalizeStoreTopicForMatch(acceptedTopic),
          topicType: "ACCEPTED",
          sortOrder: 0,
        }]
      : []),
    ...(input.storeAliases ?? []).map((alias, sortOrder) => ({
      topic: alias,
      normalizedTopic: normalizeStoreNameForMatch(alias),
      topicType: "STORE_ALIAS",
      sortOrder,
    })),
    ...(input.acceptedAlias
      ? [
          {
            topic: storeTopicWithHash(input.acceptedAlias),
            normalizedTopic: normalizeStoreTopicForMatch(input.acceptedAlias),
            topicType: "ACCEPTED_ALIAS",
            sortOrder: 1,
          },
        ]
      : []),
    ...(input.requiredTopic
      ? [
          {
            topic: storeTopicWithHash(input.requiredTopic),
            normalizedTopic: normalizeStoreTopicForMatch(input.requiredTopic),
            topicType: "REQUIRED",
            sortOrder: 0,
          },
        ]
      : []),
  ];
  await client.storeTopicEntry.createMany({
    data: entries.map((entry) => ({ ...entry, storeTopicRuleId: rule.id })),
  });
  return rule;
}

async function activeConfigs(client: PrismaClient): Promise<StoreTopicConfig[]> {
  const rules = await client.storeTopicRule.findMany({
    where: { enabled: true, deletedAt: null },
    include: {
      topicEntries: {
        where: { enabled: true, deletedAt: null },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  return rules.map((rule) => ({
    id: rule.id,
    commercePlatform: rule.commercePlatform as StoreTopicConfig["commercePlatform"],
    storeName: rule.storeName,
    normalizedStoreName: rule.normalizedStoreName,
    aliases: [
      {
        id: `${rule.id}-canonical`,
        alias: rule.storeName,
        normalizedAlias: rule.normalizedStoreName,
        enabled: rule.enabled,
      },
      ...rule.topicEntries
        .filter((entry) =>
          ["STORE_ALIAS", "ACCEPTED_ALIAS"].includes(entry.topicType),
        )
        .map((entry) => ({
          id: entry.id,
          alias: entry.topic.replace(/^#/u, ""),
          normalizedAlias: entry.normalizedTopic,
          enabled: entry.enabled,
        })),
    ],
    expectedTopic: rule.expectedTopic,
    acceptedTopics: rule.topicEntries
      .filter((entry) =>
        ["ACCEPTED", "ACCEPTED_ALIAS"].includes(entry.topicType),
      )
      .map((entry) => ({
        id: entry.id,
        topic: entry.topic,
        normalizedTopic: entry.normalizedTopic,
        sortOrder: entry.sortOrder,
        enabled: entry.enabled,
      })),
    requiredTopics: rule.topicEntries
      .filter((entry) => entry.topicType === "REQUIRED")
      .map((entry) => ({
        id: entry.id,
        topic: entry.topic,
        normalizedTopic: entry.normalizedTopic,
        sortOrder: entry.sortOrder,
        enabled: entry.enabled,
      })),
    enabled: rule.enabled,
  }));
}

async function resolve(
  client: PrismaClient,
  commercePlatform: string,
  storeName: string,
) {
  return resolveStoreTopicConfig(await activeConfigs(client), {
    commercePlatform,
    storeName,
  });
}

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-store-rule-package-"),
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "testing", "e2e-database-template.mjs"),
    ],
    {
      cwd: root,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
    },
  );
  const templatePath = path.join(
    root,
    ".playwright",
    "e2e-template",
    "baseline.db",
  );
  const sourcePath = path.join(temporaryRoot, "source.db");
  const targetPath = path.join(temporaryRoot, "target.db");
  fs.copyFileSync(templatePath, sourcePath);
  fs.copyFileSync(templatePath, targetPath);
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(targetPath, 0o600);
  sourceClient = new PrismaClient({ datasourceUrl: databaseUrl(sourcePath) });
  targetClient = new PrismaClient({ datasourceUrl: databaseUrl(targetPath) });
  await sourceClient.storeTopicEntry.deleteMany();
  await sourceClient.storeTopicRule.deleteMany();
  await targetClient.storeTopicEntry.deleteMany();
  await targetClient.storeTopicRule.deleteMany();
}, 30_000);

afterAll(async () => {
  await sourceClient?.$disconnect();
  await targetClient?.$disconnect();
  if (temporaryRoot) await removeTemporaryDirectoryWithRetry(temporaryRoot);
}, 30_000);

describe.sequential("店铺规则包 Source A → Client B", () => {
  it("旧 schema-v1 payload 不管理也不修改客户端店铺规则", async () => {
    await createStoreRule(targetClient, {
      commercePlatform: "JD",
      storeName: "客户端本地保留店铺",
      storeAliases: ["客户端本地别名"],
    });
    const legacyPayload = validateRulePayload(structuredClone(builtinRules));
    expect(legacyPayload.storeTopicRules).toBeUndefined();
    await applyRulePayload(legacyPayload, "GITHUB", targetClient);
    expect(
      await resolve(targetClient, "JD", "客户端本地别名"),
    ).toMatchObject({
      status: "MATCHED",
      matchedStoreName: "客户端本地保留店铺",
    });
  }, 30_000);

  it("导出 7 条 Kabrita STORE_ALIAS 并在 Client B 事务应用", async () => {
    for (const seed of storeNameAliasSeeds) {
      await createStoreRule(sourceClient, {
        commercePlatform: seed.commercePlatform,
        storeName: seed.canonicalStoreName,
        storeAliases: [seed.alias],
        acceptedTopic: false,
      });
    }
    await createStoreRule(sourceClient, {
      commercePlatform: "JD",
      storeName: "历史兼容标准店",
      acceptedAlias: "历史可接受店铺别名",
      requiredTopic: "京东",
    });
    const payload = await exportCurrentRulePayload(
      {
        ruleVersion: "rules-2026.08.22.10",
        minimumAppVersion: "1.1.17",
      },
      sourceClient,
    );
    const exportedAliases = payload.storeTopicRules?.flatMap((rule) =>
      rule.storeAliases.map((alias) => alias.value),
    );
    expect(exportedAliases).toEqual(
      expect.arrayContaining(storeNameAliasSeeds.map((seed) => seed.alias)),
    );
    expect(
      payload.storeTopicRules?.flatMap((rule) => rule.acceptedAliases),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "#历史可接受店铺别名" }),
      ]),
    );

    const historicalTasks = await targetClient.auditTask.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        storeName: true,
        matchedStoreName: true,
        expectedStoreTopic: true,
        expectedStoreTopics: true,
        requiredStoreTopics: true,
        storeMappingStatus: true,
      },
    });
    const historicalResults = await targetClient.auditResult.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        ruleSnapshot: true,
        storeTopicStatus: true,
        expectedStoreTopic: true,
        matchedStoreTopic: true,
        expectedStoreTopics: true,
        requiredStoreTopics: true,
        matchedStoreTopics: true,
      },
    });
    await applyRulePayload(payload, "GITHUB", targetClient);
    expect(
      await targetClient.auditTask.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          storeName: true,
          matchedStoreName: true,
          expectedStoreTopic: true,
          expectedStoreTopics: true,
          requiredStoreTopics: true,
          storeMappingStatus: true,
        },
      }),
    ).toEqual(historicalTasks);
    expect(
      await targetClient.auditResult.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          ruleSnapshot: true,
          storeTopicStatus: true,
          expectedStoreTopic: true,
          matchedStoreTopic: true,
          expectedStoreTopics: true,
          requiredStoreTopics: true,
          matchedStoreTopics: true,
        },
      }),
    ).toEqual(historicalResults);
    const matched = await resolve(
      targetClient,
      "TMALL",
      "天猫佳贝艾特海外旗舰店",
    );
    expect(matched).toMatchObject({
      status: "MATCHED",
      matchedStoreName: "kabrita海外旗舰店",
      expectedTopic: null,
      expectedTopics: [],
      requiredTopics: [],
    });
    expect(matched.expectedTopics).not.toContain("#天猫佳贝艾特海外旗舰店");
    const acceptedAlias = await resolve(
      targetClient,
      "JD",
      "历史可接受店铺别名",
    );
    expect(acceptedAlias.status).toBe("MATCHED");
    expect(acceptedAlias.expectedTopics).toContain("#历史可接受店铺别名");
    expect(acceptedAlias.requiredTopics).toContain("#京东");
  }, 30_000);

  it("第二、第三份权威快照传播 Alias 修改与删除", async () => {
    const kabrita = await sourceClient.storeTopicRule.findUniqueOrThrow({
      where: {
        commercePlatform_normalizedStoreName: {
          commercePlatform: "TMALL",
          normalizedStoreName: normalizeStoreNameForMatch("kabrita海外旗舰店"),
        },
      },
    });
    await sourceClient.storeTopicEntry.updateMany({
      where: { storeTopicRuleId: kabrita.id, topicType: "STORE_ALIAS" },
      data: { deletedAt: new Date(), enabled: false },
    });
    await sourceClient.storeTopicEntry.create({
      data: {
        storeTopicRuleId: kabrita.id,
        topic: "天猫佳贝艾特新别名",
        normalizedTopic: normalizeStoreNameForMatch("天猫佳贝艾特新别名"),
        topicType: "STORE_ALIAS",
        enabled: true,
      },
    });
    const changed = await exportCurrentRulePayload(
      {
        ruleVersion: "rules-2026.08.22.11",
        minimumAppVersion: "1.1.17",
      },
      sourceClient,
    );
    await applyRulePayload(changed, "GITHUB", targetClient);
    expect(
      (await resolve(targetClient, "TMALL", "天猫佳贝艾特新别名")).status,
    ).toBe("MATCHED");
    expect(
      (await resolve(targetClient, "TMALL", "天猫佳贝艾特海外旗舰店"))
        .status,
    ).toBe("STORE_NOT_MAPPED");

    await sourceClient.storeTopicEntry.updateMany({
      where: { storeTopicRuleId: kabrita.id, topicType: "STORE_ALIAS" },
      data: { deletedAt: new Date(), enabled: false },
    });
    const deleted = await exportCurrentRulePayload(
      {
        ruleVersion: "rules-2026.08.22.12",
        minimumAppVersion: "1.1.17",
      },
      sourceClient,
    );
    await applyRulePayload(deleted, "GITHUB", targetClient);
    expect(
      (await resolve(targetClient, "TMALL", "天猫佳贝艾特新别名")).status,
    ).toBe("STORE_NOT_MAPPED");
  }, 30_000);

  it("同名 Alias 跨平台隔离，省略 Canonical 在客户端软删除", async () => {
    const crossPlatform = structuredClone(
      await exportCurrentRulePayload(
        {
          ruleVersion: "rules-2026.08.22.13",
          minimumAppVersion: "1.1.17",
        },
        sourceClient,
      ),
    );
    crossPlatform.storeTopicRules!.push({
      key: storeTopicRuleStableKey("TMALL", "跨平台标准店"),
      commercePlatform: "TMALL",
      storeName: "跨平台标准店",
      enabled: true,
      storeAliases: [{ value: "京东佳贝艾特官方海外旗舰店", enabled: true, sortOrder: 0 }],
      acceptedTopics: [{ value: "#跨平台标准店", enabled: true, sortOrder: 0 }],
      acceptedAliases: [],
      requiredTopics: [],
    });
    expect(() => validateRulePayload(crossPlatform)).not.toThrow();
    await applyRulePayload(crossPlatform, "GITHUB", targetClient);
    expect(
      await resolve(targetClient, "TMALL", "京东佳贝艾特官方海外旗舰店"),
    ).toMatchObject({ status: "MATCHED", matchedStoreName: "跨平台标准店" });

    const withoutCrossPlatform = structuredClone(crossPlatform);
    withoutCrossPlatform.ruleVersion = "rules-2026.08.22.14";
    withoutCrossPlatform.storeTopicRules = withoutCrossPlatform.storeTopicRules!.filter(
      (rule) => rule.storeName !== "跨平台标准店",
    );
    await applyRulePayload(withoutCrossPlatform, "GITHUB", targetClient);
    const deletedRule = await targetClient.storeTopicRule.findUniqueOrThrow({
      where: {
        commercePlatform_normalizedStoreName: {
          commercePlatform: "TMALL",
          normalizedStoreName: normalizeStoreNameForMatch("跨平台标准店"),
        },
      },
    });
    expect(deletedRule).toMatchObject({ enabled: false });
    expect(deletedRule.deletedAt).toBeInstanceOf(Date);
  }, 30_000);

  it("Store apply 中途数据库失败会回滚 Canonical、Entry 和备份", async () => {
    await targetClient.$executeRawUnsafe(`
      CREATE TRIGGER "fail_store_rule_apply"
      BEFORE INSERT ON "store_topic_entries"
      WHEN NEW."topic" = 'ROLLBACK_ALIAS'
      BEGIN
        SELECT RAISE(FAIL, 'injected store apply failure');
      END;
    `);
    const beforeBackups = await targetClient.rulePackageBackup.count();
    const payload = structuredClone(validateRulePayload(builtinRules));
    payload.ruleVersion = "rules-2026.08.22.15";
    payload.minimumAppVersion = "1.1.17";
    payload.storeTopicRules = [
      {
        key: storeTopicRuleStableKey("JD", "回滚测试店铺"),
        commercePlatform: "JD",
        storeName: "回滚测试店铺",
        enabled: true,
        storeAliases: [{ value: "ROLLBACK_ALIAS", enabled: true, sortOrder: 0 }],
        acceptedTopics: [{ value: "#回滚测试店铺", enabled: true, sortOrder: 0 }],
        acceptedAliases: [],
        requiredTopics: [],
      },
    ];
    await expect(
      applyRulePayload(payload, "GITHUB", targetClient),
    ).rejects.toThrow();
    expect(
      await targetClient.storeTopicRule.findUnique({
        where: {
          commercePlatform_normalizedStoreName: {
            commercePlatform: "JD",
            normalizedStoreName: normalizeStoreNameForMatch("回滚测试店铺"),
          },
        },
      }),
    ).toBeNull();
    expect(await targetClient.rulePackageBackup.count()).toBe(beforeBackups);
  }, 30_000);
});

describe("店铺规则 Payload 冲突门禁", () => {
  const baseRule = (platform: "JD" | "TMALL", storeName: string) => ({
    key: storeTopicRuleStableKey(platform, storeName),
    commercePlatform: platform,
    storeName,
    enabled: true,
    storeAliases: [] as Array<{ value: string; enabled: boolean; sortOrder: number }>,
    acceptedTopics: [{ value: `#${storeName}`, enabled: true, sortOrder: 0 }],
    acceptedAliases: [] as Array<{ value: string; enabled: boolean; sortOrder: number }>,
    requiredTopics: [] as Array<{ value: string; enabled: boolean; sortOrder: number }>,
  });
  const payloadWith = (...rules: ReturnType<typeof baseRule>[]) => ({
    ...structuredClone(builtinRules),
    ruleVersion: "rules-2026.08.22.20",
    minimumAppVersion: "1.1.17",
    storeTopicRules: rules,
  });

  it("拒绝同平台 Alias、Canonical 和 Entry normalized collision", () => {
    const first = baseRule("JD", "标准店甲");
    const second = baseRule("JD", "标准店乙");
    first.storeAliases.push({ value: "共享别名", enabled: true, sortOrder: 0 });
    second.acceptedAliases.push({ value: "#共享别名", enabled: true, sortOrder: 0 });
    expect(() => validateRulePayload(payloadWith(first, second))).toThrow(
      /STORE_ALIAS_COLLISION/u,
    );

    const canonicalCollision = baseRule("JD", "标准店甲");
    canonicalCollision.storeAliases.push({
      value: "标准店乙",
      enabled: true,
      sortOrder: 0,
    });
    expect(() =>
      validateRulePayload(payloadWith(canonicalCollision, baseRule("JD", "标准店乙"))),
    ).toThrow(/STORE_ALIAS_COLLISION/u);

    const entryCollision = baseRule("JD", "标准店甲");
    entryCollision.requiredTopics.push({
      value: "#标准店甲",
      enabled: true,
      sortOrder: 0,
    });
    expect(() => validateRulePayload(payloadWith(entryCollision))).toThrow(
      /Entry 冲突/u,
    );
  });

  it("同名 Alias 在不同平台允许，低于 1.1.17 的软件门槛拒绝", () => {
    const jd = baseRule("JD", "京东标准店");
    const tmall = baseRule("TMALL", "天猫标准店");
    jd.storeAliases.push({ value: "跨平台同名", enabled: true, sortOrder: 0 });
    tmall.storeAliases.push({ value: "跨平台同名", enabled: true, sortOrder: 0 });
    expect(() => validateRulePayload(payloadWith(jd, tmall))).not.toThrow();
    expect(() =>
      validateRulePayload({
        ...payloadWith(jd),
        minimumAppVersion: "1.1.16",
      }),
    ).toThrow(/不能低于 1\.1\.17/u);
  });
});

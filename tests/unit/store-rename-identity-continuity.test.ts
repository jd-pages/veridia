import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyRulePayload,
  storeTopicRuleStableKey,
  validateRulePayload,
} from "@/lib/rules/package";
import { normalizeStoreNameForMatch } from "@/lib/store-topic-config";
import builtinRules from "@/rules/default-rules.json";
import { removeTemporaryDirectoryWithRetry } from "@/tests/helpers/remove-temporary-directory";

const root = process.cwd();
let temporaryRoot = "";
let database: PrismaClient;

function databaseUrl(databasePath: string) {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

function storeRule(
  storeName: string,
  storeAliases: string[] = [],
  commercePlatform: "JD" | "TMALL" = "JD",
) {
  return {
    key: storeTopicRuleStableKey(commercePlatform, storeName),
    commercePlatform,
    storeName,
    enabled: true,
    storeAliases: storeAliases.map((value, sortOrder) => ({
      value,
      enabled: true,
      sortOrder,
    })),
    acceptedTopics: [
      { value: `#${storeName}`, enabled: true, sortOrder: 0 },
    ],
    acceptedAliases: [],
    requiredTopics: [],
  };
}

function payload(
  ruleVersion: string,
  stores: ReturnType<typeof storeRule>[],
) {
  return validateRulePayload({
    ...structuredClone(builtinRules),
    ruleVersion,
    minimumAppVersion: "1.1.22",
    storeTopicRules: stores,
  });
}

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-store-rename-identity-"),
  );
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "testing", "e2e-database-template.mjs")],
    { cwd: root, env: process.env, stdio: "pipe", windowsHide: true },
  );
  const databasePath = path.join(temporaryRoot, "batch7.db");
  fs.copyFileSync(
    path.join(root, ".playwright", "e2e-template", "baseline.db"),
    databasePath,
  );
  fs.chmodSync(databasePath, 0o600);
  database = new PrismaClient({ datasourceUrl: databaseUrl(databasePath) });
  await database.storeTopicEntry.deleteMany();
  await database.storeTopicRule.deleteMany();
}, 30_000);

afterAll(async () => {
  await database?.$disconnect();
  if (temporaryRoot) await removeTemporaryDirectoryWithRetry(temporaryRoot);
}, 30_000);

beforeEach(async () => {
  await database.auditTask.deleteMany({
    where: { normalizedUrl: { startsWith: "https://example.com/batch7-" } },
  });
  await database.storeTopicEntry.deleteMany();
  await database.storeTopicRule.deleteMany();
});

describe.sequential("STORE_RENAME_IDENTITY_CONTINUITY", () => {
  it("初次创建、重复 apply 与正式改名保留 Store ID、Alias、历史引用及无关店铺", async () => {
    const oldName = "Batch7OldStoreName";
    const newName = "Batch7NewStoreName";
    const unrelatedName = "Batch7UnrelatedStore";
    const initial = payload("rules-batch7-before-1", [
      storeRule(oldName),
      storeRule(unrelatedName),
    ]);
    await applyRulePayload(
      initial,
      "GITHUB",
      database,
    );
    const original = await database.storeTopicRule.findUniqueOrThrow({
      where: {
        commercePlatform_normalizedStoreName: {
          commercePlatform: "JD",
          normalizedStoreName: normalizeStoreNameForMatch(oldName),
        },
      },
    });
    const unrelated = await database.storeTopicRule.findUniqueOrThrow({
      where: {
        commercePlatform_normalizedStoreName: {
          commercePlatform: "JD",
          normalizedStoreName: normalizeStoreNameForMatch(unrelatedName),
        },
      },
    });
    await applyRulePayload(initial, "GITHUB", database);
    expect(await database.storeTopicRule.count()).toBe(2);
    expect(
      await database.storeTopicRule.findUniqueOrThrow({
        where: { id: original.id },
      }),
    ).toMatchObject({ deletedAt: null });
    const product = await database.product.findFirstOrThrow();
    const campaign = await database.campaign.findFirstOrThrow();
    const historicalTask = await database.auditTask.create({
      data: {
        url: "https://example.com/batch7-history",
        normalizedUrl: "https://example.com/batch7-history",
        productId: product.id,
        campaignId: campaign.id,
        storeTopicRuleId: original.id,
        storeName: oldName,
      },
    });

    const renamedPayload = payload("rules-batch7-before-2", [
      storeRule(newName, [oldName]),
      storeRule(unrelatedName),
    ]);
    await applyRulePayload(renamedPayload, "GITHUB", database);
    await applyRulePayload(renamedPayload, "GITHUB", database);

    const renamed = await database.storeTopicRule.findUniqueOrThrow({
      where: {
        commercePlatform_normalizedStoreName: {
          commercePlatform: "JD",
          normalizedStoreName: normalizeStoreNameForMatch(newName),
        },
      },
      include: { topicEntries: true },
    });
    const oldRow = await database.storeTopicRule.findUniqueOrThrow({
      where: { id: original.id },
    });
    const persistedTask = await database.auditTask.findUniqueOrThrow({
      where: { id: historicalTask.id },
    });

    expect({
      sameIdentity: renamed.id === original.id,
      oldDeleted: oldRow.deletedAt !== null,
    }).toEqual({
      sameIdentity: true,
      oldDeleted: false,
    });
    expect(persistedTask.storeTopicRuleId).toBe(original.id);
    expect(
      await database.storeTopicRule.findUniqueOrThrow({
        where: { id: persistedTask.storeTopicRuleId! },
      }),
    ).toMatchObject({ storeName: newName, deletedAt: null });
    expect(
      await database.storeTopicRule.findUniqueOrThrow({
        where: { id: unrelated.id },
      }),
    ).toMatchObject({ storeName: unrelatedName, deletedAt: null });
    expect(await database.storeTopicRule.count()).toBe(2);
    expect(
      renamed.topicEntries.some(
        (entry) =>
          entry.topicType === "STORE_ALIAS" &&
          entry.normalizedTopic === normalizeStoreNameForMatch(oldName) &&
          entry.deletedAt === null,
      ),
    ).toBe(true);
  }, 30_000);

  it("A → B → C 与 A → B → A 始终保留同一 Store ID", async () => {
    const names = {
      a: "Batch7ChainA",
      b: "Batch7ChainB",
      c: "Batch7ChainC",
    };
    await applyRulePayload(
      payload("rules-batch7-chain-1", [storeRule(names.a)]),
      "GITHUB",
      database,
    );
    const original = await database.storeTopicRule.findFirstOrThrow();
    await applyRulePayload(
      payload("rules-batch7-chain-2", [storeRule(names.b, [names.a])]),
      "GITHUB",
      database,
    );
    await applyRulePayload(
      payload("rules-batch7-chain-3", [
        storeRule(names.c, [names.a, names.b]),
      ]),
      "GITHUB",
      database,
    );
    const chained = await database.storeTopicRule.findUniqueOrThrow({
      where: { id: original.id },
      include: { topicEntries: true },
    });
    expect(chained).toMatchObject({ storeName: names.c, deletedAt: null });
    expect(
      chained.topicEntries
        .filter(
          (entry) => entry.topicType === "STORE_ALIAS" && !entry.deletedAt,
        )
        .map((entry) => entry.topic)
        .sort(),
    ).toEqual([names.a, names.b].sort());
    expect(await database.storeTopicRule.count()).toBe(1);

    await applyRulePayload(
      payload("rules-batch7-chain-4", [storeRule(names.a)]),
      "GITHUB",
      database,
    );
    expect(await database.storeTopicRule.findUniqueOrThrow({
      where: { id: original.id },
    })).toMatchObject({ storeName: names.a, deletedAt: null });
    expect(await database.storeTopicRule.count()).toBe(1);
  }, 30_000);

  it("跨店 Alias 候选冲突 fail closed 且不合并或删除任一 Store", async () => {
    const alpha = "Batch7ConflictAlpha";
    const beta = "Batch7ConflictBeta";
    await applyRulePayload(
      payload("rules-batch7-conflict-1", [storeRule(alpha), storeRule(beta)]),
      "GITHUB",
      database,
    );
    const before = await database.storeTopicRule.findMany({
      orderBy: { storeName: "asc" },
    });
    await expect(
      applyRulePayload(
        payload("rules-batch7-conflict-2", [
          storeRule("Batch7ConflictGamma", [alpha, beta]),
        ]),
        "GITHUB",
        database,
      ),
    ).rejects.toThrow(/STORE_IDENTITY_CONFLICT/u);
    expect(
      await database.storeTopicRule.findMany({ orderBy: { storeName: "asc" } }),
    ).toEqual(before);
  }, 30_000);

  it("真正移除保持软删除，后续相似店铺不凭历史 Alias 复用旧 ID", async () => {
    const removedName = "Batch7RemovedStore";
    await applyRulePayload(
      payload("rules-batch7-remove-1", [storeRule(removedName)]),
      "GITHUB",
      database,
    );
    const removed = await database.storeTopicRule.findFirstOrThrow();
    await applyRulePayload(
      payload("rules-batch7-remove-2", []),
      "GITHUB",
      database,
    );
    expect(
      await database.storeTopicRule.findUniqueOrThrow({
        where: { id: removed.id },
      }),
    ).toMatchObject({ enabled: false });
    expect(
      (await database.storeTopicRule.findUniqueOrThrow({
        where: { id: removed.id },
      })).deletedAt,
    ).toBeInstanceOf(Date);

    const replacementName = "Batch7ReplacementStore";
    await applyRulePayload(
      payload("rules-batch7-remove-3", [
        storeRule(replacementName, [removedName]),
      ]),
      "GITHUB",
      database,
    );
    const replacement = await database.storeTopicRule.findUniqueOrThrow({
      where: {
        commercePlatform_normalizedStoreName: {
          commercePlatform: "JD",
          normalizedStoreName: normalizeStoreNameForMatch(replacementName),
        },
      },
    });
    expect(replacement.id).not.toBe(removed.id);
    expect(await database.storeTopicRule.count()).toBe(2);
  }, 30_000);

  it("rename → restore → rename 与重复 reapply 保持 identity 幂等", async () => {
    const nameA = "Batch7RestoreA";
    const nameB = "Batch7RestoreB";
    const originalPayload = payload("rules-batch7-restore-1", [
      storeRule(nameA),
    ]);
    const renamedPayload = payload("rules-batch7-restore-2", [
      storeRule(nameB, [nameA]),
    ]);
    await applyRulePayload(originalPayload, "GITHUB", database);
    const original = await database.storeTopicRule.findFirstOrThrow();
    await applyRulePayload(renamedPayload, "GITHUB", database);
    await applyRulePayload(originalPayload, "RESTORE", database);
    expect(await database.storeTopicRule.findUniqueOrThrow({
      where: { id: original.id },
    })).toMatchObject({ storeName: nameA, deletedAt: null });
    await applyRulePayload(renamedPayload, "GITHUB", database);
    await applyRulePayload(renamedPayload, "GITHUB", database);
    expect(await database.storeTopicRule.findUniqueOrThrow({
      where: { id: original.id },
    })).toMatchObject({ storeName: nameB, deletedAt: null });
    expect(await database.storeTopicRule.count()).toBe(1);
  }, 30_000);
});

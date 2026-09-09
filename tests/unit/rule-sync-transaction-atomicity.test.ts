import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Prisma, PrismaClient as PrismaClientType } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import builtinRules from "@/rules/default-rules.json";
import {
  storeTopicRuleStableKey,
  validateRulePayload,
} from "@/lib/rules/package";
import {
  cleanupRuleSyncTemporaryDirectory,
  commitRestoredRulePayload,
  commitSynchronizedRulePayload,
  recordRuleSyncFailure,
} from "@/lib/rules/sync";
import type { RulePackageManifest, RulePackagePayload } from "@/lib/rules/types";
import { removeTemporaryDirectoryWithRetry } from "@/tests/helpers/remove-temporary-directory";

const root = process.cwd();
let temporaryRoot = "";
let templatePath = "";

type Fault =
  | "RULE_MUTATION"
  | "METADATA_HISTORY"
  | "SUCCESS_STATE"
  | "TRANSACTION_COMMIT"
  | "RESTORE_METADATA"
  | "TEMP_CLEANUP";

function injectedError(fault: Fault) {
  return Object.assign(new Error(`TEST_INJECTED_${fault}`), {
    code: `TEST_INJECTED_${fault}`,
  });
}

function delegateWithFault<T extends object>(
  delegate: T,
  method: PropertyKey,
  shouldThrow: (args: unknown) => boolean,
  fault: Fault,
) {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === method && typeof value === "function") {
        return (args: unknown) => {
          if (shouldThrow(args)) throw injectedError(fault);
          return Reflect.apply(value, target, [args]);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function transactionClientWithFault(
  database: PrismaClientType,
  fault: Fault,
) {
  let injected = false;
  const transaction = database.$transaction.bind(database) as (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async (
          callbackOrBatch:
            | ((tx: Prisma.TransactionClient) => Promise<unknown>)
            | Prisma.PrismaPromise<unknown>[],
        ) => {
          if (Array.isArray(callbackOrBatch)) {
            return database.$transaction(callbackOrBatch);
          }
          return transaction(async (tx) => {
          const wrapped = new Proxy(tx, {
            get(transactionTarget, delegateName, transactionReceiver) {
              const delegate = Reflect.get(
                transactionTarget,
                delegateName,
                transactionReceiver,
              );
              if (delegateName === "topicRule" && fault === "RULE_MUTATION") {
                return delegateWithFault(
                  delegate,
                  "upsert",
                  () => !injected && (injected = true),
                  fault,
                );
              }
              if (
                delegateName === "ruleSyncHistory" &&
                fault === "METADATA_HISTORY"
              ) {
                return delegateWithFault(
                  delegate,
                  "update",
                  (args) => {
                    const data = (args as { data?: { status?: string } }).data;
                    return !injected && data?.status === "COMPLETED" && (injected = true);
                  },
                  fault,
                );
              }
              if (
                delegateName === "ruleSyncState" &&
                fault === "SUCCESS_STATE"
              ) {
                return delegateWithFault(
                  delegate,
                  "update",
                  (args) => {
                    const data = (args as { data?: { status?: string } }).data;
                    return !injected && data?.status === "COMPLETED" && (injected = true);
                  },
                  fault,
                );
              }
              if (
                delegateName === "rulePackageBackup" &&
                fault === "RESTORE_METADATA"
              ) {
                return delegateWithFault(
                  delegate,
                  "update",
                  (args) => {
                    const data = (args as { data?: { restoredAt?: Date } }).data;
                    return !injected && data?.restoredAt instanceof Date && (injected = true);
                  },
                  fault,
                );
              }
              return delegate;
            },
          });
          const result = await callbackOrBatch(wrapped);
          if (fault === "TRANSACTION_COMMIT" && !injected) {
            injected = true;
            throw injectedError(fault);
          }
          return result;
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClientType;
}

function packagePayload(
  version: string,
  marker: string,
  previousStoreName?: string,
) {
  const raw = structuredClone(builtinRules) as typeof builtinRules &
    Record<string, unknown>;
  raw.ruleVersion = version;
  raw.minimumAppVersion = "1.1.22";
  raw.products[0].contentDirection = `R04-${marker}-PRODUCT`;
  raw.stageGroups[0].label = `R04-${marker}-STAGE`;
  (raw.topicRules[0] as { notes?: string }).notes = `R04-${marker}-TOPIC`;
  const storeName = `R04-${marker}-STORE`;
  raw.storeTopicRules = [{
    key: storeTopicRuleStableKey("JD", storeName),
    commercePlatform: "JD",
    storeName,
    enabled: true,
    storeAliases: [
      ...(previousStoreName
        ? [{ value: previousStoreName, enabled: true, sortOrder: 0 }]
        : []),
      { value: `R04-${marker}-ALIAS`, enabled: true, sortOrder: 1 },
    ],
    acceptedTopics: [{ value: `#${storeName}`, enabled: true, sortOrder: 0 }],
    acceptedAliases: [],
    requiredTopics: [],
  }];
  return validateRulePayload(raw);
}

function manifest(payload: RulePackagePayload): RulePackageManifest {
  return {
    ruleVersion: payload.ruleVersion,
    schemaVersion: payload.schemaVersion,
    publishedAt: payload.publishedAt,
    minimumAppVersion: payload.minimumAppVersion,
    downloadUrl: `https://github.com/jd-pages/veridia-rules/releases/download/${payload.ruleVersion}/veridia-rules.zip`,
    fileSize: 1,
    sha256: "a".repeat(64),
    productCount: payload.products.length,
    activityCount: payload.campaigns.length,
    stageGroupCount: payload.stageGroups.length,
    topicRuleCount: payload.topicRules.length,
    storeTopicRuleCount: payload.storeTopicRules?.length,
    storeAliasCount: payload.storeTopicRules?.reduce(
      (count, rule) => count + rule.storeAliases.length,
      0,
    ),
  };
}

async function withDatabase(
  run: (database: PrismaClientType, databasePath: string) => Promise<void>,
) {
  const databasePath = path.join(
    temporaryRoot,
    `r04-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  fs.copyFileSync(templatePath, databasePath);
  fs.chmodSync(databasePath, 0o600);
  const database = new PrismaClient({
    datasourceUrl: `file:${databasePath.replaceAll("\\", "/")}`,
  });
  try {
    await run(database, databasePath);
  } finally {
    await database.$disconnect();
  }
}

async function beginAttempt(database: PrismaClientType, payload: RulePackagePayload) {
  const current = await database.ruleSyncState.findUniqueOrThrow({
    where: { id: "active" },
  });
  const history = await database.ruleSyncHistory.create({
    data: {
      ruleVersion: current.currentVersion,
      schemaVersion: current.schemaVersion,
      source: "GITHUB",
      status: "DOWNLOADING",
    },
  });
  await database.ruleSyncState.update({
    where: { id: "active" },
    data: { status: "APPLYING", latestVersion: payload.ruleVersion },
  });
  return history;
}

async function attemptSync(
  database: PrismaClientType,
  payload: RulePackagePayload,
  operationDatabase: PrismaClientType = database,
) {
  const history = await beginAttempt(database, payload);
  try {
    await commitSynchronizedRulePayload({
      payload,
      manifest: manifest(payload),
      historyId: history.id,
      database: operationDatabase,
    });
    return history;
  } catch (error) {
    await recordRuleSyncFailure({ historyId: history.id, error, database });
    throw new Error("暂时无法获取最新规则，已继续使用本地规则。");
  }
}

async function activeEvidence(database: PrismaClientType, payload: RulePackagePayload) {
  const [state, product, stage, topic, stores] = await Promise.all([
    database.ruleSyncState.findUniqueOrThrow({ where: { id: "active" } }),
    database.product.findUniqueOrThrow({
      where: { publishedKey: payload.products[0].key },
    }),
    database.ruleStageGroup.findUniqueOrThrow({
      where: { key: payload.stageGroups[0].key },
    }),
    database.topicRule.findUniqueOrThrow({
      where: { publishedKey: payload.topicRules[0].key },
    }),
    database.storeTopicRule.findMany({
      where: { deletedAt: null },
      select: { id: true, storeName: true },
    }),
  ]);
  return {
    version: state.currentVersion,
    status: state.status,
    product: product.contentDirection,
    stage: stage.label,
    topic: topic.notes,
    stores,
  };
}

async function expectFailedAttemptRollsBack(fault: Fault) {
  await withDatabase(async (database) => {
    const p1 = packagePayload("rules-2026.09.09.1", "P1");
    const p2 = packagePayload("rules-2026.09.09.2", "P2", "R04-P1-STORE");
    await attemptSync(database, p1);
    const before = await activeEvidence(database, p1);
    const backupsBefore = await database.rulePackageBackup.count();
    await expect(
      attemptSync(database, p2, transactionClientWithFault(database, fault)),
    ).rejects.toThrow("已继续使用本地规则");
    expect(await activeEvidence(database, p1)).toMatchObject({
      ...before,
      status: "FAILED",
    });
    expect(await database.rulePackageBackup.count()).toBe(backupsBefore);
    expect(await database.ruleSyncHistory.findFirstOrThrow({
      where: { errorCode: `TEST_INJECTED_${fault}` },
      orderBy: { createdAt: "desc" },
    })).toMatchObject({ status: "FAILED" });
  });
}

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-r04-atomicity-"));
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "testing", "e2e-database-template.mjs")],
    { cwd: root, env: process.env, stdio: "pipe", windowsHide: true },
  );
  templatePath = path.join(root, ".playwright", "e2e-template", "baseline.db");
}, 30_000);

afterAll(async () => {
  if (temporaryRoot) await removeTemporaryDirectoryWithRetry(temporaryRoot);
}, 30_000);

describe.sequential("RULE_SYNC_ATOMIC_COMMIT", () => {
  it("commit 后临时目录清理失败不覆盖已完成的同步结果", async () => {
    const cleanupError = injectedError("TEMP_CLEANUP");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(cleanupRuleSyncTemporaryDirectory(
        "R04-INJECTED-TEMPORARY-DIRECTORY",
        async () => {
          throw cleanupError;
        },
      )).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        "[VERIDIA RULE SYNC] 临时目录清理失败",
        cleanupError,
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("normal P1 → P2 同时提交规则、active package、成功状态与 history", async () => {
    await withDatabase(async (database) => {
      const p1 = packagePayload("rules-2026.09.09.1", "P1");
      const p2 = packagePayload("rules-2026.09.09.2", "P2", "R04-P1-STORE");
      await attemptSync(database, p1);
      const p1Store = (await activeEvidence(database, p1)).stores[0];
      const history = await attemptSync(database, p2);
      expect(await activeEvidence(database, p2)).toMatchObject({
        version: p2.ruleVersion,
        status: "COMPLETED",
        product: "R04-P2-PRODUCT",
        stage: "R04-P2-STAGE",
        topic: "R04-P2-TOPIC",
        stores: [{ id: p1Store.id, storeName: "R04-P2-STORE" }],
      });
      expect(await database.ruleSyncHistory.findUniqueOrThrow({
        where: { id: history.id },
      })).toMatchObject({ ruleVersion: p2.ruleVersion, status: "COMPLETED" });
    });
  }, 30_000);

  it("RULE_MUTATION：规则 mutation 中途失败时 P1 全量保持且失败 attempt 可审计", async () => {
    await expectFailedAttemptRollsBack("RULE_MUTATION");
  }, 30_000);

  it("METADATA_HISTORY：规则写完后 history metadata 失败时 P1 全量保持且失败 attempt 可审计", async () => {
    await expectFailedAttemptRollsBack("METADATA_HISTORY");
  }, 30_000);

  it("SUCCESS_STATE：最后 success state 写入失败时 P1 全量保持且失败 attempt 可审计", async () => {
    await expectFailedAttemptRollsBack("SUCCESS_STATE");
  }, 30_000);

  it("TRANSACTION_COMMIT：transaction commit reject 时 P1 全量保持且失败 attempt 可审计", async () => {
    await expectFailedAttemptRollsBack("TRANSACTION_COMMIT");
  }, 30_000);

  it("失败后相同 P2 retry 与重复 reapply 幂等且不重复 Store identity", async () => {
    await withDatabase(async (database) => {
      const p1 = packagePayload("rules-2026.09.09.1", "P1");
      const p2 = packagePayload("rules-2026.09.09.2", "P2", "R04-P1-STORE");
      await attemptSync(database, p1);
      const storeId = (await activeEvidence(database, p1)).stores[0].id;
      await expect(
        attemptSync(
          database,
          p2,
          transactionClientWithFault(database, "METADATA_HISTORY"),
        ),
      ).rejects.toThrow("已继续使用本地规则");
      await attemptSync(database, p2);
      await attemptSync(database, p2);
      const evidence = await activeEvidence(database, p2);
      expect(evidence.stores).toEqual([{ id: storeId, storeName: "R04-P2-STORE" }]);
      expect(await database.product.count({
        where: { publishedKey: { in: p2.products.map((item) => item.key) } },
      })).toBe(p2.products.length);
      expect(await database.topicRule.count({
        where: { publishedKey: { in: p2.topicRules.map((item) => item.key) } },
      })).toBe(p2.topicRules.length);
    });
  }, 30_000);

  it("commit 后 metadata 前的 crash 模拟整体 rollback，重启可见 APPLYING/P1 并可安全 retry", async () => {
    const databasePath = path.join(temporaryRoot, "r04-crash-restart.db");
    fs.copyFileSync(templatePath, databasePath);
    fs.chmodSync(databasePath, 0o600);
    const url = `file:${databasePath.replaceAll("\\", "/")}`;
    let database = new PrismaClient({ datasourceUrl: url });
    const p1 = packagePayload("rules-2026.09.09.1", "P1");
    const p2 = packagePayload("rules-2026.09.09.2", "P2", "R04-P1-STORE");
    await attemptSync(database, p1);
    const history = await beginAttempt(database, p2);
    await expect(commitSynchronizedRulePayload({
      payload: p2,
      manifest: manifest(p2),
      historyId: history.id,
      database: transactionClientWithFault(database, "METADATA_HISTORY"),
    })).rejects.toThrow("TEST_INJECTED_METADATA_HISTORY");
    await database.$disconnect();
    database = new PrismaClient({ datasourceUrl: url });
    try {
      expect(await activeEvidence(database, p1)).toMatchObject({
        version: p1.ruleVersion,
        status: "APPLYING",
        product: "R04-P1-PRODUCT",
      });
      expect(await database.ruleSyncHistory.findUniqueOrThrow({
        where: { id: history.id },
      })).toMatchObject({ status: "DOWNLOADING" });
      await commitSynchronizedRulePayload({
        payload: p2,
        manifest: manifest(p2),
        historyId: history.id,
        database,
      });
      expect(await activeEvidence(database, p2)).toMatchObject({
        version: p2.ruleVersion,
        status: "COMPLETED",
      });
    } finally {
      await database.$disconnect();
    }
  }, 30_000);

  it("restore 正常原子提交；restore metadata 失败时仍完整保留 P2", async () => {
    await withDatabase(async (database) => {
      const p1 = packagePayload("rules-2026.09.09.1", "P1");
      const p2 = packagePayload("rules-2026.09.09.2", "P2", "R04-P1-STORE");
      await attemptSync(database, p1);
      await attemptSync(database, p2);
      const backup = await database.rulePackageBackup.findFirstOrThrow({
        where: { ruleVersion: p1.ruleVersion, restoredAt: null },
        orderBy: { createdAt: "desc" },
      });
      await expect(commitRestoredRulePayload({
        payload: p1,
        backup,
        database: transactionClientWithFault(database, "RESTORE_METADATA"),
      })).rejects.toThrow("TEST_INJECTED_RESTORE_METADATA");
      expect(await activeEvidence(database, p2)).toMatchObject({
        version: p2.ruleVersion,
        status: "COMPLETED",
        product: "R04-P2-PRODUCT",
      });
      expect(await database.rulePackageBackup.findUniqueOrThrow({
        where: { id: backup.id },
      })).toMatchObject({ restoredAt: null });
      await commitRestoredRulePayload({ payload: p1, backup, database });
      expect(await activeEvidence(database, p1)).toMatchObject({
        version: p1.ruleVersion,
        status: "RESTORED",
        product: "R04-P1-PRODUCT",
      });
      expect(await database.ruleSyncHistory.findFirstOrThrow({
        where: { source: "RESTORE" },
        orderBy: { createdAt: "desc" },
      })).toMatchObject({ ruleVersion: p1.ruleVersion, status: "RESTORED" });
    });
  }, 30_000);
});

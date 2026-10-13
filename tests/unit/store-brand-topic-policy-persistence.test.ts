import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeTemporaryDirectoryWithRetry } from "@/tests/helpers/remove-temporary-directory";
const holder = vi.hoisted(() => ({ current: null as PrismaClient | null }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  const db = holder.current;
  if (!db) throw new Error("隔离DB尚未建立");
  const value = Reflect.get(db, key);
  return typeof value === "function" ? value.bind(db) : value;
} }) }));
import { createStoreTopicRule, updateStoreTopicRule, ensureStoreTopicRuleSeeds } from "@/lib/store-topic-rule-service";
import { applyRulePayload, exportCurrentRulePayload, validateRulePayload } from "@/lib/rules/package";
let directory: string;
let db: PrismaClient;
let user: { id: string; role: string };
const brands = ["政策动态品牌甲", "政策动态品牌乙", "政策动态品牌丙"];
beforeAll(async () => {
  execFileSync(process.execPath, ["scripts/testing/e2e-database-template.mjs"], { windowsHide: true, stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file:E:/veridia/.playwright/brand-policy-unused-parent.db" } });
  directory = fs.mkdtempSync(path.resolve(".playwright/brand-policy-test-"));
  const file = path.join(directory, "isolated.db");
  fs.copyFileSync(".playwright/e2e-template/baseline.db", file); fs.chmodSync(file, 0o600);
  db = new PrismaClient({ datasourceUrl: `file:${file.replaceAll("\\", "/")}` }); holder.current = db;
  user = { id: (await db.user.findFirstOrThrow({ where: { username: "admin" } })).id, role: "ADMIN" };
  for (const brandName of brands) await db.product.create({ data: { name: brandName, brandName } });
}, 30_000);

it("增量迁移保留旧店铺、Alias与业务表原值，未知佳贝艾特关联待确认且不猜测店名", () => {
  const legacyFile = path.join(directory, "legacy-upgrade.db");
  fs.copyFileSync(".playwright/e2e-template/baseline.db", legacyFile);
  fs.chmodSync(legacyFile, 0o600);
  const legacy = new DatabaseSync(legacyFile);
  try {
    legacy.exec('PRAGMA foreign_keys=ON; DROP TABLE "store_brand_topic_policies";');
    const tables = ["store_topic_rules", "store_topic_entries", "products", "campaigns", "topic_rules", "audit_results", "audit_tasks", "audit_batches", "import_records", "users"];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, legacy.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()]));
    const before = snapshot();
    legacy.exec(fs.readFileSync("prisma/migrations/202610130001_store_brand_topic_policy/migration.sql", "utf8"));
    expect(snapshot()).toEqual(before);
    const pending = legacy.prepare('SELECT * FROM store_brand_topic_policies WHERE brandName = ?').all("佳贝艾特");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every(policy => policy.requireStoreTopic === 0 && policy.reviewStatus === "PENDING_REVIEW")).toBe(true);
    const danone = legacy.prepare('SELECT * FROM store_brand_topic_policies WHERE brandName = ? AND requireStoreTopic = true').all("达能");
    expect(danone.length).toBeGreaterThan(0);
    expect(legacy.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { legacy.close(); }
});
afterAll(async () => { await db?.$disconnect(); if (directory) await removeTemporaryDirectoryWithRetry(directory); });

it("管理员店铺不因后续新增品牌和seed重启而自动开启话题审核", async () => {
  const danoneProducts = await db.product.findMany({ where: { brandName: "达能" }, select: { id: true } });
  expect(danoneProducts.length).toBeGreaterThan(0);
  const ids = danoneProducts.map(product => product.id);
  let storeId: string | undefined;
  try {
    await db.product.updateMany({ where: { id: { in: ids } }, data: { brandName: "后续品牌隔离占位" } });
    const store = await createStoreTopicRule({ commercePlatform: "JD", storeName: "后续品牌独立映射店",
      enabled: true, acceptedTopics: [{ topic: "#共用模板不代表品牌要求" }], storeAliases: [{ alias: "后续品牌店铺别名" }] }, user);
    storeId = store.id;
    expect(store.brandPolicies.some(policy => policy.brandName === "达能")).toBe(false);
  } finally {
    await db.product.updateMany({ where: { id: { in: ids } }, data: { brandName: "达能" } });
  }
  await ensureStoreTopicRuleSeeds();
  const policies = await db.storeBrandTopicPolicy.findMany({ where: { storeTopicRuleId: storeId, brandName: "达能" } });
  expect(policies).toHaveLength(2);
  expect(policies.every(policy => !policy.requireStoreTopic && policy.reviewStatus === "PENDING_REVIEW")).toBe(true);
  const identity = await db.storeTopicRule.findUniqueOrThrow({ where: { id: storeId }, include: { topicEntries: true } });
  expect(identity).toMatchObject({ enabled: true, deletedAt: null });
  expect(identity.topicEntries.some(entry => entry.topicType === "STORE_ALIAS" && entry.enabled)).toBe(true);
});

it("品牌政策原子保存、唯一约束、开启空配置拒绝，旧/新Rules与seed均不能覆盖管理员设置", async () => {
  const shared = [{ topic: "#共用话题" }];
  const policy = { brandName: brands[0], contentChannel: "XIAOHONGSHU", requireStoreTopic: true, useSharedTemplate: true, acceptedTopics: [], requiredTopics: [] };
  const store = await createStoreTopicRule({ commercePlatform: "JD", storeName: "政策隔离共享店", enabled: true, storeAliases: [{ alias: "政策上游别名" }], acceptedTopics: shared, brandPolicies: [policy] }, user);
  const before = await db.storeTopicRule.findUniqueOrThrow({ where: { id: store.id }, include: { brandPolicies: true, topicEntries: true } });
  const identity = { commercePlatform: "JD", storeName: store.storeName, enabled: true };
  await expect(updateStoreTopicRule(store.id, { ...identity, acceptedTopics: [], brandPolicies: [policy] }, user)).rejects.toThrow("没有当前渠道");
  await expect(updateStoreTopicRule(store.id, { ...identity, brandPolicies: [policy, policy] }, user)).rejects.toThrow("不能重复");
  expect(await db.storeTopicRule.findUniqueOrThrow({ where: { id: store.id }, include: { brandPolicies: true, topicEntries: true } })).toEqual(before);
  const custom = { ...policy, brandName: brands[2], useSharedTemplate: false, acceptedTopics: ["#品牌丙专属"] };
  await expect(updateStoreTopicRule(store.id, { ...identity, acceptedTopics: [], brandPolicies: [custom] }, user)).rejects.toThrow("没有当前渠道");
  expect(await db.storeTopicRule.findUniqueOrThrow({ where: { id: store.id }, include: { brandPolicies: true, topicEntries: true } })).toEqual(before);
  await updateStoreTopicRule(store.id, { ...identity, brandPolicies: [custom] }, user);
  const locked = await db.storeBrandTopicPolicy.findMany({ where: { storeTopicRuleId: store.id }, orderBy: { id: "asc" } });
  const exported = await exportCurrentRulePayload({ ruleVersion: "isolated-policy-export" }, db);
  expect(exported.minimumAppVersion).toBe("1.1.41");
  expect(exported.storeTopicRules!.find(row => row.storeName === store.storeName)!.brandPolicies)
    .toEqual(expect.arrayContaining([expect.objectContaining({ brandName: brands[2], requireStoreTopic: true, acceptedTopics: ["#品牌丙专属"] })]));
  const old = structuredClone(exported);
  for (const row of old.storeTopicRules!) delete row.brandPolicies;
  old.storeTopicRules!.find(row => row.storeName === store.storeName)!.acceptedTopics = [{ value: "#远端不得覆盖", enabled: true, sortOrder: 0 }];
  await applyRulePayload(old, "GITHUB", db);
  expect(await db.storeBrandTopicPolicy.findMany({ where: { storeTopicRuleId: store.id }, orderBy: { id: "asc" } })).toEqual(locked);
  expect((await db.storeTopicEntry.findMany({ where: { storeTopicRuleId: store.id, topicType: "ACCEPTED", deletedAt: null } })).map(row => row.topic)).toEqual(["#共用话题"]);
  const newPayload = structuredClone(exported);
  newPayload.storeTopicRules!.find(row => row.storeName === store.storeName)!.brandPolicies!.forEach(row => { row.requireStoreTopic = false; });
  await applyRulePayload(newPayload, "GITHUB", db);
  await ensureStoreTopicRuleSeeds();
  expect(await db.storeBrandTopicPolicy.findMany({ where: { storeTopicRuleId: store.id }, orderBy: { id: "asc" } })).toEqual(locked);
  const noStore = structuredClone(old); noStore.storeTopicRules = noStore.storeTopicRules!.filter(row => row.storeName !== store.storeName);
  await applyRulePayload(noStore, "GITHUB", db);
  expect(await db.storeTopicRule.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ enabled: true, deletedAt: null });
  const invalidVersion = structuredClone(exported); invalidVersion.minimumAppVersion = "1.1.40";
  expect(() => validateRulePayload(invalidVersion)).toThrow();
  expect(await db.$queryRawUnsafe("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
}, 30_000);

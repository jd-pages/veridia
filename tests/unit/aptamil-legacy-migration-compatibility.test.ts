import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

const require = createRequire(import.meta.url);
const {
  CANONICAL_RULE_ID,
  NEW_NORMALIZED_STORE_NAME,
  OLD_NORMALIZED_STORE_NAME,
  reconcileAptamilStoreRenameCollision,
} = require("../../desktop/legacy-database-reconciliation.cjs") as {
  CANONICAL_RULE_ID: string;
  NEW_NORMALIZED_STORE_NAME: string;
  OLD_NORMALIZED_STORE_NAME: string;
  reconcileAptamilStoreRenameCollision: (databasePath: string) => {
    status: string;
    reconciled: boolean;
    duplicateRuleId?: string;
    taskReferencesMoved?: number;
    duplicateEntryCount?: number;
  };
};

const root = process.cwd();
const migrationRoot = path.join(root, "prisma", "migrations");
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const bundledNode = path.join(root, "desktop-runtime", "node", "node.exe");
const legacyMigrationCutoff = "202608080001_platform_published_at_evidence";
const duplicateRuleId = "legacy-aptamil-new-name-rule";
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "veridia-aptamil-legacy-"),
);
const legacyTemplate = path.join(temporaryRoot, "legacy-1.1.12.db");
const upgradedTemplate = path.join(temporaryRoot, "upgraded-1.1.16.db");

function sqliteUrl(databasePath: string) {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

function prisma(args: string[], databasePath: string) {
  execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: sqliteUrl(databasePath) },
    stdio: "pipe",
    windowsHide: true,
    timeout: 120_000,
  });
}

function reconcileViaCli(databasePath: string) {
  const output = execFileSync(
    fs.existsSync(bundledNode) ? bundledNode : process.execPath,
    [
      path.join(root, "desktop", "legacy-database-reconciliation.cjs"),
      databasePath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  return JSON.parse(output.trim()) as ReturnType<
    typeof reconcileAptamilStoreRenameCollision
  >;
}

function copyFixture(source: string, label: string) {
  const target = path.join(temporaryRoot, `${label}-${randomUUID()}.db`);
  fs.copyFileSync(source, target);
  return target;
}

function withDatabase<T>(databasePath: string, action: (database: DatabaseSync) => T) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return action(database);
  } finally {
    database.close();
  }
}

function insertDuplicateRule(
  database: DatabaseSync,
  options: { entries?: boolean; task?: boolean } = {},
) {
  const now = new Date().toISOString();
  database
    .prepare(`
      INSERT INTO "store_topic_rules" (
        "id", "commercePlatform", "storeName", "normalizedStoreName",
        "expectedTopic", "enabled", "createdBy", "updatedBy",
        "createdAt", "updatedAt"
      ) VALUES (?, 'JD', ?, ?, ?, 1, 'legacy-user', 'legacy-user', ?, ?)
    `)
    .run(
      duplicateRuleId,
      "Aptamil爱他美海外优选进口超市",
      NEW_NORMALIZED_STORE_NAME,
      "#Aptamil爱他美海外优选进口超市",
      now,
      now,
    );

  if (options.entries) {
    const insertEntry = database.prepare(`
      INSERT INTO "store_topic_entries" (
        "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
        "sortOrder", "enabled", "createdBy", "updatedBy", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'legacy-user', 'legacy-user', ?, ?)
    `);
    insertEntry.run(
      "legacy-aptamil-primary",
      duplicateRuleId,
      "#Aptamil爱他美海外优选进口超市",
      NEW_NORMALIZED_STORE_NAME,
      "ACCEPTED",
      0,
      1,
      now,
      now,
    );
    insertEntry.run(
      "legacy-aptamil-custom",
      duplicateRuleId,
      "#用户保留话题",
      "用户保留话题",
      "ACCEPTED",
      1,
      1,
      now,
      now,
    );
    insertEntry.run(
      "legacy-aptamil-required-duplicate",
      duplicateRuleId,
      "#京东",
      "京东",
      "REQUIRED",
      0,
      1,
      now,
      now,
    );
  }

  if (options.task) insertReferencedHistory(database, now);
}

function insertReferencedHistory(database: DatabaseSync, now: string) {
  database.prepare(`
    INSERT INTO "products" (
      "id", "code", "name", "brandName", "status", "createdAt", "updatedAt"
    ) VALUES ('legacy-product', 'LEGACY-PRODUCT', 'Legacy Product', 'Legacy', 'ACTIVE', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO "campaigns" (
      "id", "productId", "name", "month", "startDate", "endDate",
      "status", "createdAt", "updatedAt"
    ) VALUES ('legacy-campaign', 'legacy-product', 'Legacy Campaign', '2026-08', ?, ?, 'ACTIVE', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO "audit_tasks" (
      "id", "url", "normalizedUrl", "productId", "campaignId", "source",
      "status", "storeTopicRuleId", "createdAt", "updatedAt"
    ) VALUES (
      'legacy-task', 'https://example.com/legacy', 'https://example.com/legacy',
      'legacy-product', 'legacy-campaign', 'MANUAL', 'COMPLETED', ?, ?, ?
    )
  `).run(duplicateRuleId, now, now);
  database.prepare(`
    INSERT INTO "note_records" ("id", "url", "createdAt", "updatedAt")
    VALUES ('legacy-note', 'https://example.com/legacy', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO "audit_results" (
      "id", "auditTaskId", "noteId", "ruleVersion", "ruleSnapshot",
      "pageStatus", "bodyStatus", "imageCount", "imageCompliant",
      "topicsCompliant", "clickableCompliant", "autoStatus", "createdAt"
    ) VALUES (
      'legacy-result', 'legacy-task', 'legacy-note', 1, '{}', 'NORMAL', 'PASS',
      2, 1, 1, 1, 'PASS', ?
    )
  `).run(now);
}

function databaseCounts(database: DatabaseSync) {
  return {
    tasks: countQuery(database, 'SELECT COUNT(*) AS count FROM "audit_tasks"'),
    results: countQuery(
      database,
      'SELECT COUNT(*) AS count FROM "audit_results"',
    ),
  };
}

function countQuery(database: DatabaseSync, sql: string, ...values: string[]) {
  const row = database.prepare(sql).get(...values);
  if (!row) throw new Error("COUNT 查询未返回结果");
  return Number(row.count);
}

function assertHealthy(database: DatabaseSync) {
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function assertFinalIdentity(
  databasePath: string,
  expectedCounts: { tasks: number; results: number },
  options: { customTopic?: boolean; referencedTask?: boolean } = {},
) {
  withDatabase(databasePath, (database) => {
    expect(
      database
        .prepare(`
          SELECT "id", "storeName", "normalizedStoreName", "expectedTopic"
          FROM "store_topic_rules"
          WHERE "commercePlatform" = 'JD' AND "normalizedStoreName" = ?
        `)
        .all(NEW_NORMALIZED_STORE_NAME),
    ).toEqual([
      {
        id: CANONICAL_RULE_ID,
        storeName: "Aptamil爱他美海外优选进口超市",
        normalizedStoreName: NEW_NORMALIZED_STORE_NAME,
        expectedTopic: "#Aptamil爱他美海外优选进口超市",
      },
    ]);
    expect(
      countQuery(
        database,
        'SELECT COUNT(*) AS count FROM "store_topic_rules" WHERE "id" = ?',
        duplicateRuleId,
      ),
    ).toBe(0);
    expect(databaseCounts(database)).toEqual(expectedCounts);
    if (options.referencedTask) {
      expect(
        database
          .prepare(`
            SELECT "url", "normalizedUrl", "productId", "campaignId",
              "status", "storeTopicRuleId"
            FROM "audit_tasks" WHERE "id" = ?
          `)
          .get("legacy-task"),
      ).toEqual({
        url: "https://example.com/legacy",
        normalizedUrl: "https://example.com/legacy",
        productId: "legacy-product",
        campaignId: "legacy-campaign",
        status: "COMPLETED",
        storeTopicRuleId: CANONICAL_RULE_ID,
      });
      expect(
        database
          .prepare(`
            SELECT "auditTaskId", "ruleVersion", "ruleSnapshot", "pageStatus",
              "bodyStatus", "autoStatus"
            FROM "audit_results" WHERE "id" = ?
          `)
          .get("legacy-result"),
      ).toEqual({
        auditTaskId: "legacy-task",
        ruleVersion: 1,
        ruleSnapshot: "{}",
        pageStatus: "NORMAL",
        bodyStatus: "PASS",
        autoStatus: "PASS",
      });
    }
    expect(
      database
        .prepare(`
          SELECT "topicType", "enabled", "deletedAt"
          FROM "store_topic_entries"
          WHERE "storeTopicRuleId" = ? AND "normalizedTopic" = ?
        `)
        .get(CANONICAL_RULE_ID, OLD_NORMALIZED_STORE_NAME),
    ).toMatchObject({ topicType: "ACCEPTED_ALIAS", enabled: 1, deletedAt: null });
    if (options.customTopic) {
      expect(
        database
          .prepare(`
            SELECT "id", "topic", "topicType", "enabled", "deletedAt",
              "createdBy", "updatedBy"
            FROM "store_topic_entries"
            WHERE "storeTopicRuleId" = ? AND "normalizedTopic" = '用户保留话题'
          `)
          .get(CANONICAL_RULE_ID),
      ).toEqual({
        id: "legacy-aptamil-custom",
        topic: "#用户保留话题",
        topicType: "ACCEPTED",
        enabled: 1,
        deletedAt: null,
        createdBy: "legacy-user",
        updatedBy: "legacy-user",
      });
    }
    assertHealthy(database);
  });
}

function reconcileAndUpgrade(
  databasePath: string,
  options: {
    customTopic?: boolean;
    referencedTask?: boolean;
    viaCli?: boolean;
  } = {},
) {
  const before = withDatabase(databasePath, databaseCounts);
  const reconciliation = options.viaCli
    ? reconcileViaCli(databasePath)
    : reconcileAptamilStoreRenameCollision(databasePath);
  prisma(["migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")], databasePath);
  assertFinalIdentity(databasePath, before, options);
  return reconciliation;
}

beforeAll(() => {
  const legacyPrismaRoot = path.join(temporaryRoot, "legacy-prisma");
  const legacyMigrations = path.join(legacyPrismaRoot, "migrations");
  fs.mkdirSync(legacyMigrations, { recursive: true });
  fs.copyFileSync(
    path.join(root, "prisma", "schema.prisma"),
    path.join(legacyPrismaRoot, "schema.prisma"),
  );
  for (const migration of fs
    .readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name <= legacyMigrationCutoff)
    .sort()) {
    fs.cpSync(
      path.join(migrationRoot, migration),
      path.join(legacyMigrations, migration),
      { recursive: true },
    );
  }
  fs.writeFileSync(legacyTemplate, "");
  prisma(
    ["migrate", "deploy", "--schema", path.join(legacyPrismaRoot, "schema.prisma")],
    legacyTemplate,
  );

  fs.writeFileSync(upgradedTemplate, "");
  prisma(
    ["migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    upgradedTemplate,
  );
}, 120_000);

afterAll(async () => {
  await removeTemporaryDirectoryWithRetry(temporaryRoot);
});

describe("Aptamil 1.1.12 legacy migration compatibility", () => {
  it("未协调的真实 1.1.12 collision fixture 稳定复现 P3018 UNIQUE", () => {
    const databasePath = copyFixture(legacyTemplate, "p3018-reproduction");
    withDatabase(databasePath, (database) => insertDuplicateRule(database));
    let details = "";
    try {
      prisma(
        [
          "migrate",
          "deploy",
          "--schema",
          path.join(root, "prisma", "schema.prisma"),
        ],
        databasePath,
      );
    } catch (error) {
      const failure = error as Error & {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      details = [failure.message, failure.stdout, failure.stderr]
        .filter(Boolean)
        .map(String)
        .join("\n");
    }
    expect(details).toContain("P3018");
    expect(details).toContain(
      "UNIQUE constraint failed: store_topic_rules.commercePlatform, store_topic_rules.normalizedStoreName",
    );
  }, 60_000);

  it("Case 1：duplicate 无引用时安全合并后完成原 migration", () => {
    const databasePath = copyFixture(legacyTemplate, "no-reference");
    withDatabase(databasePath, (database) => insertDuplicateRule(database));
    const result = reconcileAndUpgrade(databasePath);
    expect(result).toMatchObject({
      status: "RECONCILED",
      duplicateRuleId,
      taskReferencesMoved: 0,
      duplicateEntryCount: 0,
    });
  }, 60_000);

  it("Case 2：duplicate 的 AuditTask 引用迁移到 canonical，历史 Result 不变", () => {
    const databasePath = copyFixture(legacyTemplate, "task-reference");
    withDatabase(databasePath, (database) =>
      insertDuplicateRule(database, { task: true }),
    );
    const result = reconcileAndUpgrade(databasePath, { referencedTask: true });
    expect(result).toMatchObject({ taskReferencesMoved: 1 });
  }, 60_000);

  it("Case 3：duplicate StoreTopicEntry 合并并按 normalizedTopic 去重", () => {
    const databasePath = copyFixture(legacyTemplate, "entry-reference");
    withDatabase(databasePath, (database) =>
      insertDuplicateRule(database, { entries: true }),
    );
    const result = reconcileAndUpgrade(databasePath, { customTopic: true });
    expect(result).toMatchObject({ duplicateEntryCount: 3 });
  }, 60_000);

  it("Case 4：task 与 entries 同时存在时全部安全迁移", () => {
    const databasePath = copyFixture(legacyTemplate, "all-references");
    withDatabase(databasePath, (database) =>
      insertDuplicateRule(database, { entries: true, task: true }),
    );
    const result = reconcileAndUpgrade(databasePath, {
      customTopic: true,
      referencedTask: true,
      viaCli: true,
    });
    expect(result).toMatchObject({
      taskReferencesMoved: 1,
      duplicateEntryCount: 3,
    });
  }, 60_000);

  it("Case 5：canonical 已经是新名称时幂等通过", () => {
    const databasePath = copyFixture(legacyTemplate, "already-renamed");
    withDatabase(databasePath, (database) => {
      database.prepare(`
        UPDATE "store_topic_rules"
        SET "storeName" = 'Aptamil爱他美海外优选进口超市',
            "normalizedStoreName" = ?,
            "expectedTopic" = '#Aptamil爱他美海外优选进口超市'
        WHERE "id" = ?
      `).run(NEW_NORMALIZED_STORE_NAME, CANONICAL_RULE_ID);
    });
    const result = reconcileAndUpgrade(databasePath);
    expect(result.status).toBe("CANONICAL_ALREADY_RENAMED");
  }, 60_000);

  it("Case 6：无 duplicate 的干净 1.1.12 正常升级", () => {
    const databasePath = copyFixture(legacyTemplate, "clean-legacy");
    const result = reconcileAndUpgrade(databasePath);
    expect(result.status).toBe("NO_COLLISION");
  }, 60_000);

  it("Case 7：fresh DB 不协调并由正式 migrations 正常初始化", () => {
    const databasePath = path.join(temporaryRoot, `fresh-${randomUUID()}.db`);
    fs.writeFileSync(databasePath, "");
    expect(reconcileAptamilStoreRenameCollision(databasePath).status).toBe(
      "SCHEMA_NOT_READY",
    );
    prisma(["migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")], databasePath);
    assertFinalIdentity(databasePath, { tasks: 0, results: 0 });
  }, 60_000);

  it("Case 8：已成功升级的 1.1.16 DB 再启动不做任何写入", () => {
    const databasePath = copyFixture(upgradedTemplate, "already-upgraded");
    const beforeHash = createHash("sha256")
      .update(fs.readFileSync(databasePath))
      .digest("hex");
    expect(reconcileAptamilStoreRenameCollision(databasePath)).toEqual({
      status: "ALREADY_APPLIED",
      reconciled: false,
    });
    const afterHash = createHash("sha256")
      .update(fs.readFileSync(databasePath))
      .digest("hex");
    expect(afterHash).toBe(beforeHash);
    withDatabase(databasePath, assertHealthy);
  });

  it("保持已发布 Aptamil migration checksum，并在 deploy 前调用协调器", () => {
    const migration = fs
      .readFileSync(
        path.join(
          migrationRoot,
          "202608180001_aptamil_store_rename",
          "migration.sql",
        ),
        "utf8",
      )
      .replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      "0498732a5b8c632efdad7d0694c63ca91d42903ac985589b4c6f63a640078022",
    );
    const desktopMain = fs.readFileSync(
      path.join(root, "desktop", "main.cjs"),
      "utf8",
    );
    const reconcileAt = desktopMain.indexOf(
      "reconcileLegacyDatabaseBeforeMigrations(databasePath)",
    );
    const deployAt = desktopMain.indexOf(
      '[prismaCli, "migrate", "deploy", "--schema", schemaPath]',
    );
    expect(reconcileAt).toBeGreaterThan(0);
    expect(deployAt).toBeGreaterThan(reconcileAt);
  });
});

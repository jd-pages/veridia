/* eslint-disable @typescript-eslint/no-require-imports */
const { DatabaseSync } = require("node:sqlite");

const CANONICAL_RULE_ID = "store-topic-jd-01";
const OLD_NORMALIZED_STORE_NAME = "爱他美优选海外专卖店";
const NEW_NORMALIZED_STORE_NAME = "aptamil爱他美海外优选进口超市";
const RENAME_MIGRATION = "202608180001_aptamil_store_rename";

function tableExists(database, tableName) {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName),
  );
}

function successfulMigrationExists(database, migrationName) {
  if (!tableExists(database, "_prisma_migrations")) return false;
  return Boolean(
    database
      .prepare(`
        SELECT 1
        FROM "_prisma_migrations"
        WHERE "migration_name" = ?
          AND "finished_at" IS NOT NULL
          AND "rolled_back_at" IS NULL
        LIMIT 1
      `)
      .get(migrationName),
  );
}

function integrityResult(database) {
  return database.prepare("PRAGMA integrity_check").all().map((row) =>
    String(row.integrity_check),
  );
}

function foreignKeyViolations(database) {
  return database.prepare("PRAGMA foreign_key_check").all();
}

function assertHealthyDatabase(database, phase) {
  const integrity = integrityResult(database);
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    throw new Error(
      `APTAMIL legacy reconciliation ${phase} integrity_check 失败：${integrity.join(", ")}`,
    );
  }
  const violations = foreignKeyViolations(database);
  if (violations.length > 0) {
    throw new Error(
      `APTAMIL legacy reconciliation ${phase} foreign_key_check 失败：${violations.length}`,
    );
  }
}

function countRows(database, tableName) {
  return Number(
    database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get()
      .count,
  );
}

function topicKeySet(rows) {
  return new Set(rows.map((row) => String(row.normalizedTopic)));
}

function sameStringSet(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function mergeDuplicateTopicEntries(database, duplicateRuleId) {
  const canonicalEntries = database
    .prepare(`
      SELECT * FROM "store_topic_entries"
      WHERE "storeTopicRuleId" = ?
      ORDER BY "createdAt", "id"
    `)
    .all(CANONICAL_RULE_ID);
  const duplicateEntries = database
    .prepare(`
      SELECT * FROM "store_topic_entries"
      WHERE "storeTopicRuleId" = ?
      ORDER BY "createdAt", "id"
    `)
    .all(duplicateRuleId);
  const expectedTopics = topicKeySet([
    ...canonicalEntries,
    ...duplicateEntries,
  ]);
  const canonicalByTopic = new Map(
    canonicalEntries.map((entry) => [entry.normalizedTopic, entry]),
  );
  let moved = 0;
  let deduplicated = 0;

  const moveEntry = database.prepare(`
    UPDATE "store_topic_entries"
    SET "storeTopicRuleId" = ?, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ?
  `);
  const mergeIntoCanonical = database.prepare(`
    UPDATE "store_topic_entries"
    SET
      "topic" = ?,
      "topicType" = ?,
      "sortOrder" = ?,
      "enabled" = ?,
      "deletedAt" = ?,
      "updatedBy" = ?,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ?
  `);
  const deleteEntry = database.prepare(
    'DELETE FROM "store_topic_entries" WHERE "id" = ?',
  );

  for (const duplicateEntry of duplicateEntries) {
    const canonicalEntry = canonicalByTopic.get(
      duplicateEntry.normalizedTopic,
    );
    if (!canonicalEntry) {
      moveEntry.run(CANONICAL_RULE_ID, duplicateEntry.id);
      canonicalByTopic.set(duplicateEntry.normalizedTopic, duplicateEntry);
      moved += 1;
      continue;
    }

    const canonicalActive = canonicalEntry.deletedAt === null;
    const duplicateActive = duplicateEntry.deletedAt === null;
    const preferred =
      canonicalActive || !duplicateActive ? canonicalEntry : duplicateEntry;
    mergeIntoCanonical.run(
      preferred.topic,
      preferred.topicType,
      Math.min(
        Number(canonicalEntry.sortOrder),
        Number(duplicateEntry.sortOrder),
      ),
      Boolean(canonicalEntry.enabled) || Boolean(duplicateEntry.enabled)
        ? 1
        : 0,
      canonicalActive || duplicateActive ? null : preferred.deletedAt,
      preferred.updatedBy ||
        canonicalEntry.updatedBy ||
        duplicateEntry.updatedBy,
      canonicalEntry.id,
    );
    deleteEntry.run(duplicateEntry.id);
    deduplicated += 1;
  }

  const finalTopics = topicKeySet(
    database
      .prepare(`
        SELECT "normalizedTopic" FROM "store_topic_entries"
        WHERE "storeTopicRuleId" = ?
      `)
      .all(CANONICAL_RULE_ID),
  );
  if (!sameStringSet(expectedTopics, finalTopics)) {
    throw new Error("APTAMIL legacy reconciliation 店铺话题语义集合不一致");
  }
  return { moved, deduplicated, expectedTopicCount: expectedTopics.size };
}

function reconcileAptamilStoreRenameCollision(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");

    if (successfulMigrationExists(database, RENAME_MIGRATION)) {
      return { status: "ALREADY_APPLIED", reconciled: false };
    }
    if (
      !tableExists(database, "store_topic_rules") ||
      !tableExists(database, "store_topic_entries") ||
      !tableExists(database, "audit_tasks") ||
      !tableExists(database, "audit_results")
    ) {
      return { status: "SCHEMA_NOT_READY", reconciled: false };
    }

    assertHealthyDatabase(database, "before");
    const canonical = database
      .prepare(`
        SELECT "id", "commercePlatform", "normalizedStoreName"
        FROM "store_topic_rules" WHERE "id" = ?
      `)
      .get(CANONICAL_RULE_ID);
    if (!canonical) {
      return { status: "CANONICAL_NOT_FOUND", reconciled: false };
    }
    if (canonical.commercePlatform !== "JD") {
      throw new Error("APTAMIL canonical rule 的 commercePlatform 不是 JD");
    }

    const duplicate = database
      .prepare(`
        SELECT "id"
        FROM "store_topic_rules"
        WHERE "commercePlatform" = 'JD'
          AND "normalizedStoreName" = ?
          AND "id" <> ?
        LIMIT 1
      `)
      .get(NEW_NORMALIZED_STORE_NAME, CANONICAL_RULE_ID);
    if (!duplicate) {
      return {
        status:
          canonical.normalizedStoreName === NEW_NORMALIZED_STORE_NAME
            ? "CANONICAL_ALREADY_RENAMED"
            : "NO_COLLISION",
        reconciled: false,
      };
    }
    if (canonical.normalizedStoreName !== OLD_NORMALIZED_STORE_NAME) {
      throw new Error(
        "APTAMIL collision 存在，但 canonical 不处于可安全协调的旧名称状态",
      );
    }

    const duplicateRuleId = String(duplicate.id);
    const taskCountBefore = countRows(database, "audit_tasks");
    const resultCountBefore = countRows(database, "audit_results");
    const taskReferences = Number(
      database
        .prepare(`
          SELECT COUNT(*) AS count FROM "audit_tasks"
          WHERE "storeTopicRuleId" = ?
        `)
        .get(duplicateRuleId).count,
    );
    const entryCount = Number(
      database
        .prepare(`
          SELECT COUNT(*) AS count FROM "store_topic_entries"
          WHERE "storeTopicRuleId" = ?
        `)
        .get(duplicateRuleId).count,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          UPDATE "audit_tasks" SET "storeTopicRuleId" = ?
          WHERE "storeTopicRuleId" = ?
        `)
        .run(CANONICAL_RULE_ID, duplicateRuleId);
      const entries = mergeDuplicateTopicEntries(database, duplicateRuleId);
      database
        .prepare('DELETE FROM "store_topic_rules" WHERE "id" = ?')
        .run(duplicateRuleId);

      if (countRows(database, "audit_tasks") !== taskCountBefore) {
        throw new Error("APTAMIL reconciliation 改变了 AuditTask 总数");
      }
      if (countRows(database, "audit_results") !== resultCountBefore) {
        throw new Error("APTAMIL reconciliation 改变了 AuditResult 总数");
      }
      const staleReferences = Number(
        database
          .prepare(`
            SELECT COUNT(*) AS count FROM "audit_tasks"
            WHERE "storeTopicRuleId" = ?
          `)
          .get(duplicateRuleId).count,
      );
      if (staleReferences !== 0) {
        throw new Error("APTAMIL reconciliation 仍有 duplicate task 引用");
      }
      assertHealthyDatabase(database, "after");
      database.exec("COMMIT");
      return {
        status: "RECONCILED",
        reconciled: true,
        canonicalRuleId: CANONICAL_RULE_ID,
        duplicateRuleId,
        taskReferencesMoved: taskReferences,
        duplicateEntryCount: entryCount,
        entryRowsMoved: entries.moved,
        entryRowsDeduplicated: entries.deduplicated,
        finalTopicCount: entries.expectedTopicCount,
        taskCount: taskCountBefore,
        resultCount: resultCountBefore,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try {
    const databasePath = process.argv[2];
    if (!databasePath) throw new Error("未提供数据库路径");
    process.stdout.write(
      `${JSON.stringify(reconcileAptamilStoreRenameCollision(databasePath))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  CANONICAL_RULE_ID,
  NEW_NORMALIZED_STORE_NAME,
  OLD_NORMALIZED_STORE_NAME,
  RENAME_MIGRATION,
  reconcileAptamilStoreRenameCollision,
};

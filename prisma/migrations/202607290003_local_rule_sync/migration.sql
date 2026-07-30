ALTER TABLE "products" ADD COLUMN "publishedKey" TEXT;
ALTER TABLE "products" ADD COLUMN "ruleSource" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT';
CREATE UNIQUE INDEX "products_publishedKey_key" ON "products"("publishedKey");

ALTER TABLE "campaigns" ADD COLUMN "publishedKey" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "ruleSource" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT';
CREATE UNIQUE INDEX "campaigns_publishedKey_key" ON "campaigns"("publishedKey");

ALTER TABLE "topic_rules" ADD COLUMN "publishedKey" TEXT;
ALTER TABLE "topic_rules" ADD COLUMN "ruleSource" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT';
CREATE UNIQUE INDEX "topic_rules_publishedKey_key" ON "topic_rules"("publishedKey");

ALTER TABLE "audit_tasks" ADD COLUMN "softwareVersion" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "rulePackageVersion" TEXT;

ALTER TABLE "audit_results" ADD COLUMN "softwareVersion" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "audit_results" ADD COLUMN "rulePackageVersion" TEXT;

CREATE TABLE "rule_stage_groups" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "canonicalStages" TEXT NOT NULL,
    "bodyTerms" TEXT NOT NULL,
    "requiredTopic" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ruleVersion" TEXT NOT NULL,
    "ruleSource" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "rule_stage_groups_status_sortOrder_idx"
ON "rule_stage_groups"("status", "sortOrder");

CREATE TABLE "rule_sync_states" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'active',
    "currentVersion" TEXT NOT NULL,
    "latestVersion" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'BUILTIN',
    "status" TEXT NOT NULL DEFAULT 'USING_BUILTIN',
    "countsJson" TEXT NOT NULL DEFAULT '{}',
    "manifestJson" TEXT,
    "previousVersion" TEXT,
    "lastCheckedAt" DATETIME,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "rule_sync_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleVersion" TEXT,
    "schemaVersion" INTEGER,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "message" TEXT,
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "rule_sync_history_createdAt_idx" ON "rule_sync_history"("createdAt");
CREATE INDEX "rule_sync_history_status_createdAt_idx"
ON "rule_sync_history"("status", "createdAt");

CREATE TABLE "rule_package_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" DATETIME
);
CREATE INDEX "rule_package_backups_createdAt_idx"
ON "rule_package_backups"("createdAt");

INSERT OR IGNORE INTO "system_settings"
  ("id", "key", "value", "description", "isSecret", "updatedAt")
VALUES
  (
    'local-runtime-auth-mode',
    'AUTH_MODE',
    'LOCAL',
    '纯本地桌面认证模式，运行时固定为 LOCAL',
    false,
    CURRENT_TIMESTAMP
  );

-- Extend automatic audit tasks with an independently selected product stage.
ALTER TABLE "audit_batches" ADD COLUMN "productStage" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "milkType" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "productStage" TEXT;
ALTER TABLE "note_records" ADD COLUMN "isPublic" BOOLEAN;

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Preserve historical results while adding effective-body, public/retention and
-- optional visual-review evidence fields.
CREATE TABLE "new_audit_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditTaskId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "ruleSnapshot" TEXT NOT NULL,
    "pageStatus" TEXT NOT NULL,
    "bodyStatus" TEXT NOT NULL,
    "effectiveBodyLength" INTEGER NOT NULL DEFAULT 0,
    "bodyCompliant" BOOLEAN NOT NULL DEFAULT true,
    "imageCount" INTEGER NOT NULL,
    "imageCompliant" BOOLEAN NOT NULL,
    "topicsCompliant" BOOLEAN NOT NULL,
    "clickableCompliant" BOOLEAN NOT NULL,
    "missingTopics" TEXT NOT NULL DEFAULT '[]',
    "forbiddenTopics" TEXT NOT NULL DEFAULT '[]',
    "autoStatus" TEXT NOT NULL,
    "publicStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "retentionStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "retentionDueAt" DATETIME,
    "visualReviewStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "visualReviewDetails" TEXT NOT NULL DEFAULT '{}',
    "failureReasons" TEXT NOT NULL DEFAULT '[]',
    "aiStatus" TEXT NOT NULL DEFAULT 'DISABLED',
    "aiRelevance" TEXT,
    "aiReason" TEXT,
    "auditedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_results_auditTaskId_fkey" FOREIGN KEY ("auditTaskId") REFERENCES "audit_tasks" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audit_results_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "note_records" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_audit_results" (
    "aiReason", "aiRelevance", "aiStatus", "auditTaskId", "auditedAt",
    "autoStatus", "bodyStatus", "clickableCompliant", "createdAt",
    "failureReasons", "forbiddenTopics", "id", "imageCompliant",
    "imageCount", "missingTopics", "noteId", "pageStatus", "ruleSnapshot",
    "ruleVersion", "topicsCompliant"
)
SELECT
    "aiReason", "aiRelevance", "aiStatus", "auditTaskId", "auditedAt",
    "autoStatus", "bodyStatus", "clickableCompliant", "createdAt",
    "failureReasons", "forbiddenTopics", "id", "imageCompliant",
    "imageCount", "missingTopics", "noteId", "pageStatus", "ruleSnapshot",
    "ruleVersion", "topicsCompliant"
FROM "audit_results";
DROP TABLE "audit_results";
ALTER TABLE "new_audit_results" RENAME TO "audit_results";
CREATE INDEX "audit_results_autoStatus_auditedAt_idx" ON "audit_results"("autoStatus", "auditedAt");
CREATE INDEX "audit_results_auditTaskId_auditedAt_idx" ON "audit_results"("auditTaskId", "auditedAt");
CREATE INDEX "audit_results_noteId_idx" ON "audit_results"("noteId");

-- Campaigns can now own multiple product series and carry all fixed activity
-- requirements parsed from the source workbook.
CREATE TABLE "new_campaigns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "minImageCount" INTEGER NOT NULL DEFAULT 2,
    "productImageRequired" BOOLEAN NOT NULL DEFAULT false,
    "firstImageRequirement" TEXT,
    "prohibitedImageGuidance" TEXT,
    "bodyRequired" BOOLEAN NOT NULL DEFAULT true,
    "minBodyLength" INTEGER NOT NULL DEFAULT 1,
    "publicRequired" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 0,
    "rewardDescription" TEXT,
    "visualReviewGuidance" TEXT,
    "clickableTopicRequired" BOOLEAN NOT NULL DEFAULT true,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "campaigns_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_campaigns" (
    "bodyRequired", "clickableTopicRequired", "createdAt", "deletedAt",
    "endDate", "id", "minImageCount", "month", "name", "productId",
    "ruleVersion", "startDate", "status", "updatedAt", "year"
)
SELECT
    "bodyRequired", "clickableTopicRequired", "createdAt", "deletedAt",
    "endDate", "id", "minImageCount", "month", "name", "productId",
    "ruleVersion", "startDate", "status", "updatedAt",
    CAST(substr("month", 1, 4) AS INTEGER)
FROM "campaigns";
DROP TABLE "campaigns";
ALTER TABLE "new_campaigns" RENAME TO "campaigns";
CREATE INDEX "campaigns_month_status_idx" ON "campaigns"("month", "status");
CREATE INDEX "campaigns_productId_status_idx" ON "campaigns"("productId", "status");
CREATE UNIQUE INDEX "campaigns_name_month_key" ON "campaigns"("name", "month");

-- Formal product codes are optional. The Prisma id remains the internal id.
CREATE TABLE "new_products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "seriesName" TEXT,
    "category" TEXT,
    "contentDirection" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_products" (
    "brandName", "category", "code", "createdAt", "deletedAt", "id",
    "name", "seriesName", "status", "updatedAt"
)
SELECT
    "brandName", "category", "code", "createdAt", "deletedAt", "id",
    "name", "name", "status", "updatedAt"
FROM "products";
DROP TABLE "products";
ALTER TABLE "new_products" RENAME TO "products";
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");
CREATE INDEX "products_name_idx" ON "products"("name");
CREATE INDEX "products_brandName_status_idx" ON "products"("brandName", "status");

-- Topic policy and semantic category are stored independently; a stage rule
-- is loaded only when the task selected the same stage.
CREATE TABLE "new_topic_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'CAMPAIGN',
    "campaignId" TEXT,
    "productId" TEXT,
    "ruleType" TEXT NOT NULL,
    "topicCategory" TEXT NOT NULL DEFAULT 'GENERAL',
    "applicableStage" TEXT,
    "topic" TEXT NOT NULL,
    "exactMatch" BOOLEAN NOT NULL DEFAULT true,
    "clickableRequired" BOOLEAN NOT NULL DEFAULT false,
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
    "minCount" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "topic_rules_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "topic_rules_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_topic_rules" (
    "campaignId", "caseSensitive", "clickableRequired", "createdAt",
    "exactMatch", "id", "minCount", "notes", "productId", "ruleType",
    "scope", "sortOrder", "status", "topic", "updatedAt", "version"
)
SELECT
    "campaignId", "caseSensitive", "clickableRequired", "createdAt",
    "exactMatch", "id", "minCount", "notes", "productId", "ruleType",
    "scope", "sortOrder", "status", "topic", "updatedAt", "version"
FROM "topic_rules";
DROP TABLE "topic_rules";
ALTER TABLE "new_topic_rules" RENAME TO "topic_rules";
CREATE INDEX "topic_rules_scope_status_idx" ON "topic_rules"("scope", "status");
CREATE INDEX "topic_rules_campaignId_status_sortOrder_idx" ON "topic_rules"("campaignId", "status", "sortOrder");
CREATE INDEX "topic_rules_productId_status_idx" ON "topic_rules"("productId", "status");
CREATE INDEX "topic_rules_campaignId_applicableStage_status_idx" ON "topic_rules"("campaignId", "applicableStage", "status");

CREATE TABLE "campaign_products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_products_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "campaign_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "campaign_products" ("id", "campaignId", "productId", "sortOrder")
SELECT 'legacy-' || "id", "id", "productId", 0
FROM "campaigns"
WHERE "productId" IS NOT NULL;
CREATE INDEX "campaign_products_productId_campaignId_idx" ON "campaign_products"("productId", "campaignId");
CREATE UNIQUE INDEX "campaign_products_campaignId_productId_key" ON "campaign_products"("campaignId", "productId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "product_aliases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_aliases_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "minImageCount" INTEGER NOT NULL DEFAULT 2,
    "bodyRequired" BOOLEAN NOT NULL DEFAULT true,
    "clickableTopicRequired" BOOLEAN NOT NULL DEFAULT true,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "campaigns_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "topic_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'CAMPAIGN',
    "campaignId" TEXT,
    "productId" TEXT,
    "ruleType" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "audit_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "audit_tasks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audit_tasks_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "note_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platformNoteId" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "authorName" TEXT,
    "publishedAt" DATETIME,
    "pageStatus" TEXT NOT NULL DEFAULT 'NORMAL',
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "imageUrls" TEXT NOT NULL DEFAULT '[]',
    "firstCapturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCapturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "note_products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "confidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "note_products_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "note_records" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "note_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "note_topics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "displayText" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "isLinkElement" BOOLEAN NOT NULL DEFAULT false,
    "hasHref" BOOLEAN NOT NULL DEFAULT false,
    "href" TEXT,
    "textColor" TEXT,
    "styleFeature" BOOLEAN NOT NULL DEFAULT false,
    "isClickable" BOOLEAN NOT NULL DEFAULT false,
    "domPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "note_topics_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "note_records" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "extraction_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditTaskId" TEXT,
    "noteId" TEXT NOT NULL,
    "adapterName" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "pageStatus" TEXT NOT NULL,
    "rawData" TEXT NOT NULL,
    "extractedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "extraction_records_auditTaskId_fkey" FOREIGN KEY ("auditTaskId") REFERENCES "audit_tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "extraction_records_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "note_records" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditTaskId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "ruleSnapshot" TEXT NOT NULL,
    "pageStatus" TEXT NOT NULL,
    "bodyStatus" TEXT NOT NULL,
    "imageCount" INTEGER NOT NULL,
    "imageCompliant" BOOLEAN NOT NULL,
    "topicsCompliant" BOOLEAN NOT NULL,
    "clickableCompliant" BOOLEAN NOT NULL,
    "missingTopics" TEXT NOT NULL DEFAULT '[]',
    "forbiddenTopics" TEXT NOT NULL DEFAULT '[]',
    "autoStatus" TEXT NOT NULL,
    "failureReasons" TEXT NOT NULL DEFAULT '[]',
    "aiStatus" TEXT NOT NULL DEFAULT 'DISABLED',
    "aiRelevance" TEXT,
    "aiReason" TEXT,
    "auditedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_results_auditTaskId_fkey" FOREIGN KEY ("auditTaskId") REFERENCES "audit_tasks" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audit_results_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "note_records" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "rule_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditResultId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "expectedValue" TEXT NOT NULL,
    "actualValue" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "evidence" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rule_results_auditResultId_fkey" FOREIGN KEY ("auditResultId") REFERENCES "audit_results" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "manual_reviews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditResultId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manual_reviews_auditResultId_fkey" FOREIGN KEY ("auditResultId") REFERENCES "audit_results" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "manual_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "operation_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" TEXT DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "operation_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "import_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileName" TEXT NOT NULL,
    "importType" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "validCount" INTEGER NOT NULL,
    "invalidCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "products_brandName_status_idx" ON "products"("brandName", "status");

-- CreateIndex
CREATE INDEX "product_aliases_alias_idx" ON "product_aliases"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "product_aliases_productId_alias_key" ON "product_aliases"("productId", "alias");

-- CreateIndex
CREATE INDEX "campaigns_month_status_idx" ON "campaigns"("month", "status");

-- CreateIndex
CREATE INDEX "campaigns_productId_status_idx" ON "campaigns"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_productId_name_month_key" ON "campaigns"("productId", "name", "month");

-- CreateIndex
CREATE INDEX "topic_rules_scope_status_idx" ON "topic_rules"("scope", "status");

-- CreateIndex
CREATE INDEX "topic_rules_campaignId_status_sortOrder_idx" ON "topic_rules"("campaignId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "topic_rules_productId_status_idx" ON "topic_rules"("productId", "status");

-- CreateIndex
CREATE INDEX "audit_tasks_status_createdAt_idx" ON "audit_tasks"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_tasks_campaignId_status_idx" ON "audit_tasks"("campaignId", "status");

-- CreateIndex
CREATE INDEX "audit_tasks_normalizedUrl_idx" ON "audit_tasks"("normalizedUrl");

-- CreateIndex
CREATE UNIQUE INDEX "note_records_platformNoteId_key" ON "note_records"("platformNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "note_records_url_key" ON "note_records"("url");

-- CreateIndex
CREATE INDEX "note_records_pageStatus_idx" ON "note_records"("pageStatus");

-- CreateIndex
CREATE INDEX "note_products_productId_idx" ON "note_products"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "note_products_noteId_productId_key" ON "note_products"("noteId", "productId");

-- CreateIndex
CREATE INDEX "note_topics_noteId_normalizedText_idx" ON "note_topics"("noteId", "normalizedText");

-- CreateIndex
CREATE INDEX "extraction_records_auditTaskId_extractedAt_idx" ON "extraction_records"("auditTaskId", "extractedAt");

-- CreateIndex
CREATE INDEX "extraction_records_noteId_extractedAt_idx" ON "extraction_records"("noteId", "extractedAt");

-- CreateIndex
CREATE INDEX "audit_results_autoStatus_auditedAt_idx" ON "audit_results"("autoStatus", "auditedAt");

-- CreateIndex
CREATE INDEX "audit_results_auditTaskId_auditedAt_idx" ON "audit_results"("auditTaskId", "auditedAt");

-- CreateIndex
CREATE INDEX "audit_results_noteId_idx" ON "audit_results"("noteId");

-- CreateIndex
CREATE INDEX "rule_results_auditResultId_passed_idx" ON "rule_results"("auditResultId", "passed");

-- CreateIndex
CREATE INDEX "manual_reviews_auditResultId_createdAt_idx" ON "manual_reviews"("auditResultId", "createdAt");

-- CreateIndex
CREATE INDEX "manual_reviews_reviewerId_idx" ON "manual_reviews"("reviewerId");

-- CreateIndex
CREATE INDEX "operation_logs_entityType_entityId_idx" ON "operation_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "operation_logs_createdAt_idx" ON "operation_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE INDEX "import_records_importType_createdAt_idx" ON "import_records"("importType", "createdAt");

-- CreateTable
CREATE TABLE "audit_batches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "productId" TEXT,
    "campaignId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "intervalMs" INTEGER NOT NULL DEFAULT 5000,
    "currentTaskId" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdBy" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "pausedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "audit_batches_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audit_batches_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audit_batches_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "automation_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "profilePath" TEXT NOT NULL,
    "lastCheckedAt" DATETIME,
    "lastLoginAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTable
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_audit_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "queueOrder" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "audit_tasks_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "audit_batches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audit_tasks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audit_tasks_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_audit_tasks" (
    "id", "url", "normalizedUrl", "productId", "campaignId", "source",
    "status", "notes", "createdBy", "createdAt", "updatedAt"
)
SELECT
    "id", "url", "normalizedUrl", "productId", "campaignId", "source",
    "status", "notes", "createdBy", "createdAt", "updatedAt"
FROM "audit_tasks";
DROP TABLE "audit_tasks";
ALTER TABLE "new_audit_tasks" RENAME TO "audit_tasks";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "audit_batches_status_createdAt_idx" ON "audit_batches"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_batches_createdBy_createdAt_idx" ON "audit_batches"("createdBy", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_sessions_platform_key" ON "automation_sessions"("platform");

-- CreateIndex
CREATE INDEX "audit_tasks_status_createdAt_idx" ON "audit_tasks"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_tasks_batchId_status_queueOrder_idx" ON "audit_tasks"("batchId", "status", "queueOrder");

-- CreateIndex
CREATE INDEX "audit_tasks_campaignId_status_idx" ON "audit_tasks"("campaignId", "status");

-- CreateIndex
CREATE INDEX "audit_tasks_normalizedUrl_idx" ON "audit_tasks"("normalizedUrl");

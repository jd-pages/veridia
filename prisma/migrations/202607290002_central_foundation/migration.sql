-- 第一阶段仅预留中央身份字段；全部允许为空，不改变现有本地用户主键和登录方式。
ALTER TABLE "users" ADD COLUMN "authProvider" TEXT;
ALTER TABLE "users" ADD COLUMN "centralUserId" TEXT;
ALTER TABLE "users" ADD COLUMN "teamId" TEXT;
ALTER TABLE "users" ADD COLUMN "centralRole" TEXT;
ALTER TABLE "users" ADD COLUMN "centralStatus" TEXT;
ALTER TABLE "users" ADD COLUMN "lastCentralVerifiedAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "offlineValidUntil" DATETIME;

CREATE UNIQUE INDEX "users_centralUserId_key"
ON "users"("centralUserId");

CREATE INDEX "users_teamId_centralStatus_idx"
ON "users"("teamId", "centralStatus");

-- deviceId 在应用层使用 crypto.randomUUID() 生成，不读取硬盘、网卡或其他硬件标识。
CREATE TABLE "local_devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "local_devices_deviceId_key"
ON "local_devices"("deviceId");

CREATE TABLE "local_usage_summaries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "localUserId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "softwareVersion" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "taskCount" INTEGER NOT NULL DEFAULT 0,
    "auditCount" INTEGER NOT NULL DEFAULT 0,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "nonSensitiveErrorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "local_usage_summaries_localUserId_fkey"
      FOREIGN KEY ("localUserId") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "local_usage_summaries_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "local_devices" ("deviceId")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "local_usage_summaries_date_localUserId_deviceId_key"
ON "local_usage_summaries"("date", "localUserId", "deviceId");

CREATE INDEX "local_usage_summaries_localUserId_date_idx"
ON "local_usage_summaries"("localUserId", "date");

CREATE INDEX "local_usage_summaries_deviceId_date_idx"
ON "local_usage_summaries"("deviceId", "date");

-- 为未来 DUAL/CENTRAL 模式预留配置。本阶段业务代码始终沿用 LOCAL 登录链路。
INSERT OR IGNORE INTO "system_settings"
  ("id", "key", "value", "description", "isSecret", "updatedAt")
VALUES
  (
    'central-foundation-auth-mode',
    'AUTH_MODE',
    'LOCAL',
    '认证模式：LOCAL / DUAL / CENTRAL；第一阶段固定使用 LOCAL',
    false,
    CURRENT_TIMESTAMP
  );

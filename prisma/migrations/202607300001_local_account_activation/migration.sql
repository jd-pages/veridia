ALTER TABLE "users" ADD COLUMN "normalizedUsername" TEXT;
ALTER TABLE "users" ADD COLUMN "accountId" TEXT;
ALTER TABLE "users" ADD COLUMN "lastLocalLoginAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "issuedAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "activatedAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "activationIssuer" TEXT;
ALTER TABLE "users" ADD COLUMN "activationSignature" TEXT;
ALTER TABLE "users" ADD COLUMN "activationSchemaVersion" INTEGER;
ALTER TABLE "users" ADD COLUMN "authorizationVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN "lastSeenClockAt" DATETIME;

CREATE UNIQUE INDEX "users_normalizedUsername_key" ON "users"("normalizedUsername");
CREATE UNIQUE INDEX "users_accountId_key" ON "users"("accountId");
CREATE INDEX "users_accountId_status_idx" ON "users"("accountId", "status");

CREATE TABLE "local_auth_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "sessionVersion" INTEGER NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_auth_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "local_auth_sessions_tokenHash_key"
  ON "local_auth_sessions"("tokenHash");
CREATE INDEX "local_auth_sessions_userId_revokedAt_expiresAt_idx"
  ON "local_auth_sessions"("userId", "revokedAt", "expiresAt");

CREATE TABLE "local_login_throttles" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "normalizedUsername" TEXT NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "blockedUntil" DATETIME,
  "lastFailureAt" DATETIME,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "local_login_throttles_normalizedUsername_key"
  ON "local_login_throttles"("normalizedUsername");
CREATE INDEX "local_login_throttles_blockedUntil_idx"
  ON "local_login_throttles"("blockedUntil");

CREATE TABLE "account_code_uses" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "codeDigest" TEXT NOT NULL,
  "codeKind" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "account_code_uses_codeDigest_key"
  ON "account_code_uses"("codeDigest");
CREATE INDEX "account_code_uses_accountId_codeKind_usedAt_idx"
  ON "account_code_uses"("accountId", "codeKind", "usedAt");

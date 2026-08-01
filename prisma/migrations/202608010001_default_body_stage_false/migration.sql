PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_rule_stage_groups" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "canonicalStages" TEXT NOT NULL,
    "bodyTerms" TEXT NOT NULL,
    "requireBodyStage" BOOLEAN NOT NULL DEFAULT false,
    "requiredTopic" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ruleVersion" TEXT NOT NULL,
    "ruleSource" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_rule_stage_groups" (
    "key",
    "label",
    "canonicalStages",
    "bodyTerms",
    "requireBodyStage",
    "requiredTopic",
    "sortOrder",
    "status",
    "ruleVersion",
    "ruleSource",
    "createdAt",
    "updatedAt"
)
SELECT
    "key",
    "label",
    "canonicalStages",
    "bodyTerms",
    false,
    "requiredTopic",
    "sortOrder",
    "status",
    "ruleVersion",
    "ruleSource",
    "createdAt",
    "updatedAt"
FROM "rule_stage_groups";

DROP TABLE "rule_stage_groups";
ALTER TABLE "new_rule_stage_groups" RENAME TO "rule_stage_groups";

CREATE INDEX "rule_stage_groups_status_sortOrder_idx"
ON "rule_stage_groups"("status", "sortOrder");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

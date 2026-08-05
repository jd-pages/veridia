ALTER TABLE "audit_tasks" ADD COLUMN "platform" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "storeName" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "orderNumber" TEXT;

-- Older Excel imports stored these values as labelled lines in notes. Backfill
-- only unambiguous values so existing business records remain searchable.
UPDATE "audit_tasks"
SET "platform" = CASE
  WHEN "notes" LIKE '%平台：小红书%' THEN 'XIAOHONGSHU'
  WHEN "notes" LIKE '%平台：抖音%' THEN 'DOUYIN'
  ELSE NULL
END
WHERE "platform" IS NULL;

UPDATE "audit_tasks"
SET "storeName" = trim(substr(
  "notes",
  instr("notes", '店铺名称：') + length('店铺名称：'),
  CASE
    WHEN instr(substr("notes", instr("notes", '店铺名称：') + length('店铺名称：')), char(10)) > 0
      THEN instr(substr("notes", instr("notes", '店铺名称：') + length('店铺名称：')), char(10)) - 1
    ELSE length("notes")
  END
))
WHERE "storeName" IS NULL AND instr(coalesce("notes", ''), '店铺名称：') > 0;

UPDATE "audit_tasks"
SET "orderNumber" = trim(substr(
  "notes",
  instr("notes", '订单编号：') + length('订单编号：'),
  CASE
    WHEN instr(substr("notes", instr("notes", '订单编号：') + length('订单编号：')), char(10)) > 0
      THEN instr(substr("notes", instr("notes", '订单编号：') + length('订单编号：')), char(10)) - 1
    ELSE length("notes")
  END
))
WHERE "orderNumber" IS NULL AND instr(coalesce("notes", ''), '订单编号：') > 0;

CREATE INDEX "audit_tasks_platform_idx" ON "audit_tasks"("platform");
CREATE INDEX "audit_tasks_orderNumber_idx" ON "audit_tasks"("orderNumber");

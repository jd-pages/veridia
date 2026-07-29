ALTER TABLE "campaigns" ADD COLUMN "customerRegistrationNotes" TEXT;

UPDATE "campaigns"
SET "customerRegistrationNotes" =
  CASE
    WHEN COALESCE("visualReviewGuidance", '') <> '' THEN
      '历史图片要求（仅供客服登记参考，不参与自动审核）：' || "visualReviewGuidance"
    WHEN "minImageCount" > 0 OR "productImageRequired" = 1 THEN
      '历史图片要求（仅供客服登记参考，不参与自动审核）：至少 ' ||
      CAST("minImageCount" AS TEXT) || ' 张；' ||
      CASE WHEN "productImageRequired" = 1 THEN '要求包含产品图片' ELSE '无产品图片自动要求' END
    ELSE NULL
  END
WHERE "customerRegistrationNotes" IS NULL;

UPDATE "audit_tasks"
SET
  "status" = 'READ_FAILED',
  "failureMessage" = '图片读取已退出审核范围，可重新审核正文、话题和公开状态',
  "finishedAt" = CURRENT_TIMESTAMP
WHERE "failureCode" LIKE '%IMAGES_NOT_RECOGNIZED%';

UPDATE "campaigns"
SET "customerRegistrationNotes" =
  '历史图片要求（仅供客服登记参考，不参与自动审核）：至少 ' ||
  CAST("minImageCount" AS TEXT) || ' 张；' ||
  CASE
    WHEN "productImageRequired" = 1 THEN '要求包含产品图片；'
    ELSE ''
  END ||
  CASE
    WHEN COALESCE("firstImageRequirement", '') <> '' THEN
      '首图要求：' || "firstImageRequirement" || '；'
    ELSE ''
  END ||
  CASE
    WHEN COALESCE("prohibitedImageGuidance", '') <> '' THEN
      '图片注意事项：' || "prohibitedImageGuidance" || '；'
    ELSE ''
  END ||
  CASE
    WHEN COALESCE("visualReviewGuidance", '') <> '' THEN
      '原视觉说明：' || "visualReviewGuidance"
    ELSE ''
  END
WHERE
  "minImageCount" > 0 OR
  "productImageRequired" = 1 OR
  COALESCE("firstImageRequirement", '') <> '' OR
  COALESCE("prohibitedImageGuidance", '') <> '' OR
  COALESCE("visualReviewGuidance", '') <> '';

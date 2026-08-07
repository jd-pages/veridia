-- Douyin campaigns do not participate in the XHS public-status audit.
-- This only updates campaign configuration; historical audit results are untouched.

UPDATE "campaigns"
SET "publicRequired" = false,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "contentChannel" = 'DOUYIN'
  AND "publicRequired" <> false;

import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createAuditIngestFixture } from "../helpers/audit-ingest-fixture";
import { buildImportXlsx } from "../helpers/import-row-limit";

const limitMessage =
  "导入文件包含 5001 条非空数据，最多支持 5000 条；本次未导入任何数据。";

test("A10: 5000 条完整预检，5001 条在预检和提交入口均整批拒绝", async ({ page }) => {
  test.setTimeout(180_000);
  const databaseUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("必须通过 isolated E2E runner 提供 E2E_DATABASE_URL");
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>> | undefined;
  try {
    const login = await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "Admin123!" },
    });
    expect(login.status()).toBe(200);
    fixture = await createAuditIngestFixture(db);
    await db.campaign.update({
      where: { id: fixture.campaign.id },
      data: { contentChannel: "DOUYIN" },
    });
    await db.topicRule.updateMany({
      where: { productId: fixture.product.id, campaignId: fixture.campaign.id },
      data: {
        contentChannel: "DOUYIN",
        applicableStage: "IFFO_2",
        milkType: "IFFO",
      },
    });
    const fixtureOptions = {
      productName: fixture.product.name,
      activityName: fixture.campaign.name,
      contentChannel: "抖音" as const,
    };

    const allowed = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: "A10-5000.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await buildImportXlsx(5000, 1000, fixtureOptions)),
        },
        commit: "false",
        requestKey: "a10-allowed-5000",
      },
    });
    const allowedPayload = await allowed.json();
    expect(allowed.status(), JSON.stringify(allowedPayload)).toBe(200);
    expect(
      allowedPayload.data.rows[0].errors,
      JSON.stringify(allowedPayload.data.rows[0]),
    ).toEqual([]);
    expect(allowedPayload.data).toMatchObject({
      total: 5000,
      validCount: 5000,
      invalidCount: 0,
      importableCount: 5000,
      imported: 0,
      rowsTruncated: true,
    });

    const before = {
      imports: await db.importRecord.count(),
      batches: await db.auditBatch.count(),
      tasks: await db.auditTask.count(),
    };
    const oversizedBytes = Buffer.from(await buildImportXlsx(5001, 0, fixtureOptions));
    for (const commit of [false, true]) {
      const response = await page.request.post("/api/import/notes", {
        multipart: {
          file: {
            name: `A10-5001-${commit ? "commit" : "preview"}.xlsx`,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: oversizedBytes,
          },
          commit: String(commit),
          requestKey: `a10-rejected-${commit ? "commit" : "preview"}`,
        },
      });
      expect(response.status()).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: limitMessage,
        errorDetail: { code: "IMPORT_ROW_LIMIT_EXCEEDED", message: limitMessage },
      });
    }
    expect({
      imports: await db.importRecord.count(),
      batches: await db.auditBatch.count(),
      tasks: await db.auditTask.count(),
    }).toEqual(before);

  } finally {
    try { await fixture?.cleanup(); } finally { await db.$disconnect(); }
  }
});

test("A10: 超限错误在导入 UI 明确显示且不呈现成功", async ({ page }) => {
  test.setTimeout(60_000);
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.status()).toBe(200);
  await page.goto("/tasks");
  await page.getByRole("tab", { name: "Excel 自动审核" }).click();
  const oversizedBytes = Buffer.from(await buildImportXlsx(5001));
  await page.locator('input[type="file"][accept*="xlsx"]').setInputFiles({
    name: "A10-5001-ui.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: oversizedBytes,
  });
  await page.getByRole("button", { name: "开始预检查" }).click();
  await expect(page.getByText(limitMessage, { exact: true })).toBeVisible();
  await expect(page.getByText("预检查完成", { exact: true })).toHaveCount(0);
});

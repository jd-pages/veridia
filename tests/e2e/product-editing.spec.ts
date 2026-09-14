import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

function isolatedDatabase() {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) {
    throw new Error("产品编辑测试只能使用隔离 E2E 数据库");
  }
  return new PrismaClient({ datasourceUrl });
}

test("能恩全护产品可新增并重复保存同一别名", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  try {
    const existingProduct = await db.product.findFirst({
      where: { publishedKey: "product_nestle_nan_7hmo" },
      include: { aliases: { orderBy: { alias: "asc" } } },
    });
    const product = existingProduct || await db.product.create({
      data: {
        publishedKey: `e2e-product-nestle-nan-${Date.now()}`,
        ruleSource: "REMOTE_SYNC",
        code: null,
        name: "能恩全护 7HMO",
        brandName: "雀巢",
        seriesName: "能恩全护 7HMO",
        aliases: { create: [{ alias: "能恩全护7HMO" }] },
      },
      include: { aliases: { orderBy: { alias: "asc" } } },
    });
    const operationLogsBefore = await db.operationLog.count({
      where: { action: "UPDATE_PRODUCT", entityId: product.id },
    });
    const payload = {
      code: product.code || "",
      name: "能恩全护",
      brandName: "雀巢",
      seriesName: "能恩全护 7HMO",
      category: product.category || "",
      contentDirection: product.contentDirection || "",
      aliases: ["能恩全护7HMO"],
    };

    const first = await page.request.put(`/api/products/${product.id}`, {
      data: payload,
    });
    const firstBody = await first.json();
    const afterFirst = await db.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { aliases: { orderBy: { alias: "asc" } } },
    });
    const operationLogsAfterFirst = await db.operationLog.count({
      where: { action: "UPDATE_PRODUCT", entityId: product.id },
    });
    console.info(
      `[PRODUCT_EDIT_REPRODUCTION] ${JSON.stringify({
        payload,
        httpStatus: first.status(),
        responseBody: firstBody,
        productBefore: {
          name: product.name,
          brandName: product.brandName,
          seriesName: product.seriesName,
          code: product.code,
          aliases: product.aliases.map((item) => item.alias),
        },
        productAfter: {
          name: afterFirst.name,
          brandName: afterFirst.brandName,
          seriesName: afterFirst.seriesName,
          code: afterFirst.code,
          aliases: afterFirst.aliases.map((item) => item.alias),
        },
        operationLogsBefore,
        operationLogsAfterFirst,
      })}`,
    );

    expect(first.status()).toBe(200);
    expect(firstBody).toMatchObject({ success: true });
    expect(afterFirst.aliases.map((item) => item.alias)).toEqual([
      "能恩全护7HMO",
    ]);
    expect(operationLogsAfterFirst).toBe(operationLogsBefore + 1);

    const second = await page.request.put(`/api/products/${product.id}`, {
      data: payload,
    });
    expect(second.status()).toBe(200);
    expect((await second.json()).success).toBe(true);
    expect(
      (
        await db.product.findUniqueOrThrow({
          where: { id: product.id },
          include: { aliases: true },
        })
      ).aliases.map((item) => item.alias),
    ).toEqual(["能恩全护7HMO"]);
  } finally {
    await db.$disconnect();
  }
});

test("产品编辑明确分类冲突和不存在错误，并在事务失败时完整回滚", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = `${Date.now()}`;
  const triggerNames: string[] = [];
  try {
    const first = await db.product.create({
      data: {
        publishedKey: `e2e-product-edit-first-${suffix}`,
        code: `EDIT-A-${suffix}`,
        name: `事务产品A${suffix}`,
        brandName: "雀巢",
      },
    });
    const second = await db.product.create({
      data: {
        publishedKey: `e2e-product-edit-second-${suffix}`,
        code: null,
        name: `事务产品B${suffix}`,
        brandName: "雀巢",
        aliases: { create: [{ alias: `旧别名${suffix}` }] },
      },
    });

    const duplicateCode = await page.request.put(`/api/products/${second.id}`, {
      data: {
        code: first.code,
        name: second.name,
        brandName: second.brandName,
        aliases: [`旧别名${suffix}`],
      },
    });
    expect(duplicateCode.status()).toBe(409);
    expect(await duplicateCode.json()).toMatchObject({
      errorDetail: { code: "PRODUCT_CODE_DUPLICATE" },
    });

    const missing = await page.request.put(`/api/products/missing-${suffix}`, {
      data: { name: "不存在", brandName: "雀巢" },
    });
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toMatchObject({
      errorDetail: { code: "PRODUCT_NOT_FOUND" },
    });

    const aliasTrigger = `e2e_alias_failure_${suffix}`;
    triggerNames.push(aliasTrigger);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${aliasTrigger}" BEFORE INSERT ON "product_aliases" WHEN NEW."productId" = '${second.id}' BEGIN SELECT RAISE(ABORT, 'simulated alias failure'); END`,
    );
    const aliasFailure = await page.request.put(`/api/products/${second.id}`, {
      data: {
        code: "",
        name: `不应提交${suffix}`,
        brandName: "雀巢",
        aliases: [`新别名${suffix}`],
      },
    });
    expect(aliasFailure.status()).toBe(500);
    await db.$executeRawUnsafe(`DROP TRIGGER "${aliasTrigger}"`);
    triggerNames.splice(triggerNames.indexOf(aliasTrigger), 1);
    expect(await db.product.findUniqueOrThrow({
      where: { id: second.id },
      include: { aliases: true },
    })).toMatchObject({
      name: `事务产品B${suffix}`,
      code: null,
      aliases: [{ alias: `旧别名${suffix}` }],
    });

    const logTrigger = `e2e_log_failure_${suffix}`;
    triggerNames.push(logTrigger);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${logTrigger}" BEFORE INSERT ON "operation_logs" WHEN NEW."entityId" = '${second.id}' BEGIN SELECT RAISE(ABORT, 'simulated log failure'); END`,
    );
    const logFailure = await page.request.put(`/api/products/${second.id}`, {
      data: {
        code: "",
        name: `审计失败不应提交${suffix}`,
        brandName: "雀巢",
        aliases: [`审计失败别名${suffix}`],
      },
    });
    expect(logFailure.status()).toBe(500);
    await db.$executeRawUnsafe(`DROP TRIGGER "${logTrigger}"`);
    triggerNames.splice(triggerNames.indexOf(logTrigger), 1);
    expect(await db.product.findUniqueOrThrow({
      where: { id: second.id },
      include: { aliases: true },
    })).toMatchObject({
      name: `事务产品B${suffix}`,
      aliases: [{ alias: `旧别名${suffix}` }],
    });

    const normalized = await page.request.put(`/api/products/${second.id}`, {
      data: {
        code: "",
        name: second.name,
        brandName: "雀巢",
        aliases: [` 能恩全护7HMO；能恩全护7HMO;\n能恩全护 7HMO `],
      },
    });
    expect(normalized.status()).toBe(200);
    expect((await db.product.findUniqueOrThrow({
      where: { id: second.id },
      include: { aliases: { orderBy: { alias: "asc" } } },
    })).aliases.map((item) => item.alias)).toEqual([
      "能恩全护 7HMO",
      "能恩全护7HMO",
    ]);
  } finally {
    for (const triggerName of triggerNames) {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}"`);
    }
    await db.product.deleteMany({
      where: { publishedKey: { in: [
        `e2e-product-edit-first-${suffix}`,
        `e2e-product-edit-second-${suffix}`,
      ] } },
    });
    await db.$disconnect();
  }
});

test("产品编辑失败保留弹窗输入，成功后关闭并刷新列表", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = `${Date.now()}`;
  const product = await db.product.create({
    data: {
      publishedKey: `e2e-product-ui-${suffix}`,
      name: `UI产品${suffix}`,
      brandName: "雀巢",
    },
  });
  try {
    await page.goto("/products");
    const search = page.getByPlaceholder("搜索编码、名称、品牌或别名");
    await search.fill(product.name);
    await search.press("Enter");
    const row = page.locator(".ant-table-row").filter({ hasText: product.name });
    await row.getByRole("button", { name: "编辑" }).click();
    const modal = page.locator(".ant-modal:visible");
    await expect(modal.getByText("编辑产品", { exact: true })).toBeVisible();
    const aliasValue = `保留输入${suffix}`;
    await modal.getByLabel("产品别名").fill(aliasValue);
    await page.route(`**/api/products/${product.id}`, async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "产品编码已被其他产品使用",
            errorDetail: {
              code: "PRODUCT_CODE_DUPLICATE",
              message: "产品编码已被其他产品使用",
            },
          }),
        });
      } else {
        await route.continue();
      }
    });
    await modal.locator(".ant-modal-footer .ant-btn-primary").click();
    await expect(page.getByText("产品编码已被其他产品使用")).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel("产品别名")).toHaveValue(aliasValue);
    await expect(modal.locator(".ant-modal-footer .ant-btn-primary")).toBeEnabled();

    await page.unroute(`**/api/products/${product.id}`);
    const updatedName = `UI产品已更新${suffix}`;
    await modal.getByLabel("产品名称").fill(updatedName);
    await modal.locator(".ant-modal-footer .ant-btn-primary").click();
    await expect(modal).toBeHidden();
    await expect(page.getByText("产品已更新")).toBeVisible();
    await search.fill(updatedName);
    await search.press("Enter");
    await expect(page.locator(".ant-table-row").filter({ hasText: updatedName })).toBeVisible();
  } finally {
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});

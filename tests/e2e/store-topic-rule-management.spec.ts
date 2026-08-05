import { expect, test } from "@playwright/test";

test("活动与规则可独立维护店铺话题规则", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/campaigns");
  await page.getByRole("tab", { name: "店铺话题规则" }).click();
  await expect(page.getByRole("button", { name: /新增店铺/u })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "搜索店铺名称" });
  await search.fill("FOLO");
  await search.press("Enter");
  await expect(page.getByRole("cell", { name: "folo海外专营店", exact: true })).toBeVisible();

  const suffix = String(Date.now()).slice(-8);
  const originalName = `TestShop${suffix}海外专营店`;
  const editedName = `TESTSHOP${suffix}海外专营店`;
  await search.clear();
  await search.press("Enter");
  await page.getByRole("button", { name: /新增店铺/u }).click();
  await page.getByLabel("标准店铺名称").fill(originalName);
  await expect(page.getByRole("dialog").locator("input[disabled]")).toHaveValue(`#${originalName}`);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const createdResponse = await page.request.post("/api/store-topic-rules", {
    data: { commercePlatform: "TMALL", storeName: originalName, enabled: true },
  });
  expect(createdResponse.ok()).toBeTruthy();
  const created = (await createdResponse.json()).data as { id: string };

  const duplicate = await page.request.post("/api/store-topic-rules", {
    data: {
      commercePlatform: "TMALL",
      storeName: originalName.toLowerCase(),
      enabled: true,
    },
  });
  expect(duplicate.ok()).toBeFalsy();
  expect((await duplicate.json()).error).toContain("已存在相同店铺");

  await page.getByRole("button", { name: /刷新/u }).click();
  await search.fill(originalName.toLowerCase());
  await search.press("Enter");
  const row = page.getByRole("row").filter({ hasText: originalName });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /编辑/u }).click();
  await page.getByLabel("标准店铺名称").fill(editedName);
  await expect(page.getByRole("dialog").locator("input[disabled]")).toHaveValue(`#${editedName}`);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const edited = await page.request.patch(`/api/store-topic-rules/${created.id}`, {
    data: { commercePlatform: "TMALL", storeName: editedName, enabled: true },
  });
  expect(edited.ok()).toBeTruthy();
  expect((await edited.json()).data.expectedTopic).toBe(`#${editedName}`);

  await page.getByRole("button", { name: /刷新/u }).click();
  await search.fill(editedName.toLowerCase());
  await search.press("Enter");
  const editedRow = page.getByRole("row").filter({ hasText: editedName });
  await expect(editedRow).toBeVisible();
  const disabled = await page.request.patch(`/api/store-topic-rules/${created.id}`, {
    data: { commercePlatform: "TMALL", storeName: editedName, enabled: false },
  });
  expect(disabled.ok()).toBeTruthy();
  expect((await disabled.json()).data.enabled).toBe(false);
  const products = (await (await page.request.get("/api/products")).json()).data as Array<{ id: string; name: string }>;
  const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
  const campaigns = (await (await page.request.get(`/api/campaigns?productId=${product.id}`)).json()).data as Array<{ name: string; month: string }>;
  const campaign = campaigns.find((item) => item.month === "2026-07")!;
  const csv = [
    "笔记链接,产品,活动,产品阶段话题,店铺名称,成交平台,内容渠道",
    `http://localhost:3100/mock/xhs?case=passed&store-disabled=${suffix},${product.name},${campaign.name},IFFO,${editedName},天猫,小红书`,
  ].join("\r\n");
  const disabledPreview = await page.request.post("/api/import/notes", {
    multipart: {
      file: { name: "disabled-store.csv", mimeType: "text/csv", buffer: Buffer.from(`\uFEFF${csv}`) },
      commit: "false",
      tencentExport: "true",
    },
  });
  expect(disabledPreview.ok()).toBeTruthy();
  const disabledPreviewData = (await disabledPreview.json()).data;
  expect(disabledPreviewData.invalidCount).toBe(1);
  expect(disabledPreviewData.rows[0].errors.join("；")).toContain("STORE_NOT_MAPPED");
  const enabled = await page.request.patch(`/api/store-topic-rules/${created.id}`, {
    data: { commercePlatform: "TMALL", storeName: editedName, enabled: true },
  });
  expect(enabled.ok()).toBeTruthy();
  const enabledPreview = await page.request.post("/api/import/notes", {
    multipart: {
      file: { name: "enabled-store.csv", mimeType: "text/csv", buffer: Buffer.from(`\uFEFF${csv}`) },
      commit: "false",
      tencentExport: "true",
    },
  });
  expect(enabledPreview.ok()).toBeTruthy();
  expect((await enabledPreview.json()).data.validCount).toBe(1);

  const resultCountBefore = (await (await page.request.get("/api/results?page=1&pageSize=1")).json()).data.total;
  const deleted = await page.request.delete(`/api/store-topic-rules/${created.id}`);
  expect(deleted.ok()).toBeTruthy();
  await page.getByRole("button", { name: /刷新/u }).click();
  await expect(page.getByRole("cell", { name: editedName, exact: true })).toHaveCount(0);
  const resultCountAfter = (await (await page.request.get("/api/results?page=1&pageSize=1")).json()).data.total;
  expect(resultCountAfter).toBe(resultCountBefore);
});

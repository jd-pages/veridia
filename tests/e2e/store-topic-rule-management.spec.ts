import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";

test("活动与规则可独立维护店铺话题规则", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/campaigns");
  const createStoreButton = page.getByRole("button", { name: /新增店铺/u });
  await expect(async () => {
    if (!(await createStoreButton.isVisible())) {
      await page.getByRole("tab", { name: "店铺话题规则" }).click();
    }
    await expect(createStoreButton).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });

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
  await expect(page.getByLabel("可接受店铺话题 1")).toHaveValue(originalName);
  await page.getByRole("button", { name: "添加话题" }).click();
  await expect(page.getByLabel("可接受店铺话题 2")).toBeVisible();
  const alternateTopic = `TestShop${suffix}海外旗舰店`;
  await page.getByLabel("可接受店铺话题 2").fill(alternateTopic);
  await page.getByRole("button", { name: "添加必需话题" }).click();
  const requiredTopic = `平台必需话题${suffix}`;
  await page.getByTestId("required-store-topic-0").fill(requiredTopic);
  await page.getByTestId("save-store-topic-rule").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const createdPage = await page.request.get(
    `/api/store-topic-rules?query=${encodeURIComponent(originalName)}&pageSize=10`,
  );
  const createdItems = (await createdPage.json()).data.items as Array<{
    id: string;
    acceptedTopics: Array<{ topic: string }>;
    requiredTopics: Array<{ topic: string }>;
  }>;
  const created = createdItems.find((item) =>
    item.acceptedTopics.some((topic) => topic.topic === `#${alternateTopic}`),
  )!;
  expect(created).toBeTruthy();
  expect(created.acceptedTopics.map((topic) => topic.topic)).toEqual([
    `#${originalName}`,
    `#${alternateTopic}`,
  ]);
  expect(created.requiredTopics.map((topic) => topic.topic)).toEqual([
    `#${requiredTopic}`,
  ]);

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
  await expect(row.getByText(`#${originalName}`, { exact: true })).toBeVisible();
  await expect(row.getByText(`#${alternateTopic}`, { exact: true })).toBeVisible();
  await expect(row.getByText(`#${requiredTopic}`, { exact: true })).toBeVisible();
  await row.getByRole("button", { name: /编辑/u }).click();
  await page.getByLabel("标准店铺名称").fill(editedName);
  await expect(page.getByLabel("可接受店铺话题 1")).toHaveValue(editedName);
  await expect(page.getByLabel("可接受店铺话题 2")).toHaveValue(alternateTopic);
  await expect(page.getByTestId("required-store-topic-0")).toHaveValue(requiredTopic);
  await page.getByTestId("save-store-topic-rule").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const editedResponse = await page.request.get(
    `/api/store-topic-rules?query=${encodeURIComponent(editedName)}&pageSize=10`,
  );
  const editedData = (await editedResponse.json()).data.items.find(
    (item: { id: string }) => item.id === created.id,
  );
  expect(editedData.expectedTopic).toBe(`#${editedName}`);
  expect(editedData.acceptedTopics.map((topic: { topic: string }) => topic.topic))
    .toEqual([`#${editedName}`, `#${alternateTopic}`]);
  expect(editedData.requiredTopics.map((topic: { topic: string }) => topic.topic))
    .toEqual([`#${requiredTopic}`]);

  await page.getByRole("button", { name: /刷新/u }).click();
  await search.fill(editedName.toLowerCase());
  await search.press("Enter");
  const editedRow = page.getByRole("row").filter({ hasText: editedName });
  await expect(editedRow).toBeVisible();
  await editedRow.getByRole("button", { name: /编辑/u }).click();
  const customTopic = `自定义${suffix}话题`;
  await page.getByLabel("可接受店铺话题 1").fill(customTopic);
  await page.getByLabel("标准店铺名称").fill(`${editedName}更新`);
  await expect(page.getByLabel("可接受店铺话题 1")).toHaveValue(customTopic);
  await expect(page.getByLabel("可接受店铺话题 2")).toHaveValue(alternateTopic);
  await expect(page.getByTestId("required-store-topic-0")).toHaveValue(requiredTopic);
  await page.getByLabel("可接受店铺话题 2").fill(customTopic.toLowerCase());
  await page.getByTestId("save-store-topic-rule").click();
  await expect(page.getByText(/已存在相同话题/u)).toBeVisible();
  await page.getByTestId("cancel-store-topic-rule").click();
  const disabled = await page.request.patch(`/api/store-topic-rules/${created.id}`, {
    data: { commercePlatform: "TMALL", storeName: editedName, enabled: false },
  });
  expect(disabled.ok()).toBeTruthy();
  expect((await disabled.json()).data.enabled).toBe(false);
  const products = (await (await page.request.get("/api/products")).json()).data as Array<{ id: string; name: string }>;
  const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
  const campaigns = (await (
    await page.request.get(
      `/api/campaigns?productId=${product.id}&contentChannel=XIAOHONGSHU`,
    )
  ).json()).data as Array<{ name: string; month: string }>;
  const campaign = campaigns.find((item) => item.month === "2026-07")!;
  const workbook = new ExcelJS.Workbook();
  const importSheet = workbook.addWorksheet("兼容导入");
  importSheet.addRow([
    "笔记链接", "产品", "活动名称", "产品阶段话题",
    "店铺名称", "成交平台", "内容渠道",
  ]);
  importSheet.addRow([
    `http://localhost:3100/mock/xhs?case=passed&store-disabled=${suffix}`,
    product.name, campaign.name, "IFFO", editedName, "天猫", "小红书",
  ]);
  const importBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const disabledPreview = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "disabled-store.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: importBuffer,
      },
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
      file: {
        name: "enabled-store.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: importBuffer,
      },
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

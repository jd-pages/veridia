import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { ensureStoreTopicRuleSeeds } from "@/lib/store-topic-rule-service";
import { E2E_ORIGIN } from "./e2e-origin";

test.beforeAll(async () => {
  await ensureStoreTopicRuleSeeds();
});

test("佳贝艾特 Canonical 可不要求店铺话题并保留 STORE_ALIAS", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();

  const canonicalStoreName = "佳贝艾特官方海外旗舰店";
  const explicitAlias = "京东佳贝艾特官方海外旗舰店";
  const getRule = async () => {
    const response = await page.request.get(
      `/api/store-topic-rules?commercePlatform=JD&query=${encodeURIComponent(canonicalStoreName)}&pageSize=10`,
    );
    expect(response.ok()).toBeTruthy();
    return (await response.json()).data.items.find(
      (item: { storeName: string }) => item.storeName === canonicalStoreName,
    ) as {
      id: string;
      storeName: string;
      enabled: boolean;
      aliases: Array<{ alias: string }>;
      storeAliases: Array<{ alias: string }>;
      acceptedTopics: Array<{ id: string; topic: string; enabled: boolean }>;
      requiredTopics: Array<{ id: string; topic: string; enabled: boolean }>;
    };
  };

  const before = await getRule();
  expect(before).toBeTruthy();
  expect(before.aliases.map((item) => item.alias)).toEqual([
    canonicalStoreName,
    explicitAlias,
  ]);
  expect(before.storeAliases.map((item) => item.alias)).toEqual([explicitAlias]);
  expect(before.acceptedTopics).toEqual([]);

  const update = await page.request.patch(`/api/store-topic-rules/${before.id}`, {
    data: {
      commercePlatform: "JD",
      storeName: canonicalStoreName,
      enabled: before.enabled,
      acceptedTopics: before.acceptedTopics,
      requiredTopics: before.requiredTopics,
    },
  });
  expect(update.ok(), JSON.stringify(await update.json())).toBeTruthy();

  const after = await getRule();
  expect(after.aliases.map((item) => item.alias)).toEqual([
    canonicalStoreName,
    explicitAlias,
  ]);
  expect(after.storeAliases.map((item) => item.alias)).toEqual([explicitAlias]);
  expect(after.acceptedTopics).toEqual([]);
});

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

  const search = page.getByRole("searchbox", { name: "搜索标准店铺或导入别名" });
  await search.fill("FOLO");
  await search.press("Enter");
  await expect(page.getByRole("cell", { name: "folo海外专营店", exact: true })).toBeVisible();

  const suffix = String(Date.now()).slice(-8);
  const originalName = `TestShop${suffix}海外专营店`;
  const editedName = `TESTSHOP${suffix}海外专营店`;
  const createdAlias = `上游TestShop${suffix}名称`;
  await search.clear();
  await search.press("Enter");
  await page.getByRole("button", { name: /新增店铺/u }).click();
  await page.getByLabel("标准店铺名称").fill(originalName);
  await page.getByRole("button", { name: "添加导入别名" }).click();
  await page.getByTestId("store-alias-0").fill(createdAlias);
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
    storeAliases: Array<{ alias: string }>;
    acceptedTopics: Array<{ topic: string }>;
    requiredTopics: Array<{ topic: string }>;
  }>;
  const created = createdItems.find((item) =>
    item.acceptedTopics.some((topic) => topic.topic === `#${alternateTopic}`),
  )!;
  expect(created).toBeTruthy();
  expect(created.storeAliases.map((alias) => alias.alias)).toEqual([createdAlias]);
  expect(created.acceptedTopics.map((topic) => topic.topic)).toEqual([
    `#${originalName}`,
    `#${alternateTopic}`,
  ]);
  expect(created.requiredTopics.map((topic) => topic.topic)).toEqual([
    `#${requiredTopic}`,
  ]);

  await search.fill(createdAlias);
  await search.press("Enter");
  const aliasSearchRow = page.getByRole("row").filter({ hasText: originalName });
  await expect(aliasSearchRow).toBeVisible();
  await expect(aliasSearchRow.getByText(createdAlias, { exact: true })).toBeVisible();

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
  expect(editedData.storeAliases.map((alias: { alias: string }) => alias.alias))
    .toEqual([createdAlias]);
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

test("用户可在页面用 STORE_ALIAS 闭环修复 STORE_NOT_MAPPED", async ({
  page,
}) => {
  test.setTimeout(90_000);
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();

  const suffix = `${Date.now()}`.slice(-9);
  const canonicalStoreName = `AliasSelfService${suffix}旗舰店`;
  const upstreamAlias = `上游自助店铺${suffix}`;
  const editedAlias = `${upstreamAlias}编辑后`;
  const createResponse = await page.request.post("/api/store-topic-rules", {
    data: {
      commercePlatform: "TMALL",
      storeName: canonicalStoreName,
      enabled: true,
      acceptedTopics: [{ topic: canonicalStoreName, enabled: true }],
      requiredTopics: [],
    },
  });
  const createPayload = await createResponse.json();
  expect(createResponse.ok(), JSON.stringify(createPayload)).toBeTruthy();
  const ruleId = createPayload.data.id as string;

  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string }>;
  const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
  const campaigns = (await (await page.request.get(
    `/api/campaigns?productId=${product.id}&contentChannel=XIAOHONGSHU`,
  )).json()).data as Array<{ name: string; month: string }>;
  const campaign = campaigns.find((item) => item.month === "2026-07")!;
  expect(product).toBeTruthy();
  expect(campaign).toBeTruthy();

  const previewStore = async (storeName: string, marker: string) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("导入别名自助预检");
    sheet.addRow([
      "笔记链接", "产品", "活动名称", "产品阶段话题",
      "店铺名称", "成交平台", "内容渠道",
    ]);
    sheet.addRow([
      `${E2E_ORIGIN}/mock/xhs?case=passed&store-alias-self-service=${suffix}-${marker}`,
      product.name,
      campaign.name,
      "IFFO",
      storeName,
      "天猫",
      "小红书",
    ]);
    const response = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: `store-alias-${marker}.xlsx`,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        },
        commit: "false",
        tencentExport: "true",
      },
    });
    const payload = await response.json();
    expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
    return payload.data as {
      validCount: number;
      invalidCount: number;
      rows: Array<{
        errors: string[];
        matchedStoreName: string;
        storeMappingStatus: string;
      }>;
    };
  };

  try {
    const before = await previewStore(upstreamAlias, "before");
    expect(before.invalidCount).toBe(1);
    expect(before.rows[0].errors.join("；")).toContain("STORE_NOT_MAPPED");

    await page.goto("/campaigns");
    const createStoreButton = page.getByRole("button", { name: /新增店铺/u });
    await expect(async () => {
      if (!(await createStoreButton.isVisible())) {
        await page.getByRole("tab", { name: "店铺话题规则" }).click();
      }
      await expect(createStoreButton).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const search = page.getByRole("searchbox", {
      name: "搜索标准店铺或导入别名",
    });
    await search.fill(canonicalStoreName);
    await search.press("Enter");
    let row = page.getByRole("row").filter({ hasText: canonicalStoreName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /编辑/u }).click();
    await expect(page.getByText(
      "用于匹配 Excel / 上游系统中的店铺名称，不参与小红书或抖音页面话题审核。",
      { exact: true },
    )).toBeVisible();
    await page.getByRole("button", { name: "添加导入别名" }).click();
    await page.getByTestId("store-alias-0").fill(upstreamAlias);
    await page.getByTestId("save-store-topic-rule").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const matched = await previewStore(upstreamAlias, "added");
    expect(matched).toMatchObject({ validCount: 1, invalidCount: 0 });
    expect(matched.rows[0]).toMatchObject({
      matchedStoreName: canonicalStoreName,
      storeMappingStatus: "MATCHED",
    });

    const disableWithoutAliases = await page.request.patch(
      `/api/store-topic-rules/${ruleId}`,
      { data: { commercePlatform: "TMALL", storeName: canonicalStoreName, enabled: false } },
    );
    expect(disableWithoutAliases.ok()).toBeTruthy();
    expect((await disableWithoutAliases.json()).data.storeAliases).toMatchObject([
      { alias: upstreamAlias },
    ]);
    const enableWithoutAliases = await page.request.patch(
      `/api/store-topic-rules/${ruleId}`,
      { data: { commercePlatform: "TMALL", storeName: canonicalStoreName, enabled: true } },
    );
    expect(enableWithoutAliases.ok()).toBeTruthy();
    expect((await enableWithoutAliases.json()).data.storeAliases).toMatchObject([
      { alias: upstreamAlias },
    ]);

    await page.getByRole("button", { name: /刷新/u }).click();
    await search.fill(upstreamAlias);
    await search.press("Enter");
    row = page.getByRole("row").filter({ hasText: canonicalStoreName });
    await expect(row).toBeVisible();
    await expect(row.getByText(upstreamAlias, { exact: true })).toBeVisible();
    await row.getByRole("button", { name: /编辑/u }).click();
    await page.getByTestId("store-alias-0").fill(editedAlias);
    await page.getByTestId("save-store-topic-rule").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const oldAfterEdit = await previewStore(upstreamAlias, "old-after-edit");
    expect(oldAfterEdit.invalidCount).toBe(1);
    expect(oldAfterEdit.rows[0].errors.join("；")).toContain("STORE_NOT_MAPPED");
    const editedMatched = await previewStore(editedAlias, "edited");
    expect(editedMatched.rows[0]).toMatchObject({
      matchedStoreName: canonicalStoreName,
      storeMappingStatus: "MATCHED",
    });

    await search.fill(canonicalStoreName);
    await search.press("Enter");
    row = page.getByRole("row").filter({ hasText: canonicalStoreName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /编辑/u }).click();
    await page.getByRole("button", { name: "删除导入别名 1" }).click();
    await page.getByTestId("save-store-topic-rule").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const afterDelete = await previewStore(editedAlias, "deleted");
    expect(afterDelete.invalidCount).toBe(1);
    expect(afterDelete.rows[0].errors.join("；")).toContain("STORE_NOT_MAPPED");

    const aliasLogs = await prisma.operationLog.findMany({
      where: {
        action: "UPDATE_STORE_TOPIC_RULE",
        entityType: "STORE_TOPIC_RULE",
        entityId: ruleId,
      },
      orderBy: { createdAt: "desc" },
    });
    const metadataHistory = aliasLogs.map((log) =>
      JSON.parse(log.metadata || "{}") as {
        beforeStoreAliases: Array<{ alias: string }>;
        afterStoreAliases: Array<{ alias: string }>;
      }
    );
    expect(metadataHistory.some((metadata) =>
      metadata.afterStoreAliases?.some((alias) => alias.alias === upstreamAlias)
    )).toBe(true);
    const deleteMetadata = metadataHistory[0] as {
      beforeStoreAliases: Array<{ alias: string }>;
      afterStoreAliases: Array<{ alias: string }>;
    };
    expect(deleteMetadata.beforeStoreAliases).toMatchObject([{ alias: editedAlias }]);
    expect(deleteMetadata.afterStoreAliases).toEqual([]);
  } finally {
    await page.request.delete(`/api/store-topic-rules/${ruleId}`);
  }
});

test("STORE_ALIAS collision 仅在同平台阻断且包含历史 ACCEPTED_ALIAS", async ({
  page,
}) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();
  const suffix = `${Date.now()}`.slice(-9);
  const sharedAlias = `跨平台可复用别名${suffix}`;
  const jdCanonical = `碰撞店铺JD${suffix}`;
  const ids: string[] = [];
  const create = async (
    commercePlatform: "JD" | "TMALL",
    storeName: string,
    storeAliases: Array<{ alias: string }> = [],
  ) => {
    const response = await page.request.post("/api/store-topic-rules", {
      data: { commercePlatform, storeName, enabled: true, storeAliases },
    });
    const payload = await response.json();
    if (response.ok()) ids.push(payload.data.id);
    return { response, payload };
  };

  try {
    const jd = await create("JD", jdCanonical, [{ alias: sharedAlias }]);
    expect(jd.response.ok(), JSON.stringify(jd.payload)).toBeTruthy();
    const tmall = await create("TMALL", `碰撞店铺TMALL${suffix}`, [
      { alias: sharedAlias },
    ]);
    expect(tmall.response.ok(), JSON.stringify(tmall.payload)).toBeTruthy();

    const samePlatformAlias = await create("JD", `碰撞店铺JD其他${suffix}`, [
      { alias: sharedAlias },
    ]);
    expect(samePlatformAlias.response.ok()).toBeFalsy();
    expect(samePlatformAlias.payload.error).toContain("STORE_ALIAS_COLLISION");
    expect(samePlatformAlias.payload.error).toContain(jdCanonical);

    const canonicalTarget = await create("JD", `碰撞目标店铺${suffix}`);
    expect(canonicalTarget.response.ok()).toBeTruthy();
    const canonicalCollision = await page.request.patch(
      `/api/store-topic-rules/${canonicalTarget.payload.data.id}`,
      {
        data: {
          commercePlatform: "JD",
          storeName: canonicalTarget.payload.data.storeName,
          enabled: true,
          storeAliases: [{ alias: jdCanonical }],
        },
      },
    );
    expect(canonicalCollision.ok()).toBeFalsy();
    expect((await canonicalCollision.json()).error).toContain("STORE_ALIAS_COLLISION");

    const acceptedAliasCollision = await create("JD", `历史别名碰撞店铺${suffix}`, [
      { alias: "爱他美优选海外专卖店" },
    ]);
    expect(acceptedAliasCollision.response.ok()).toBeFalsy();
    expect(acceptedAliasCollision.payload.error).toContain("STORE_ALIAS_COLLISION");

    const selfCanonical = `Canonical自身${suffix}`;
    const selfCollision = await create("JD", selfCanonical, [
      { alias: selfCanonical.toLowerCase() },
    ]);
    expect(selfCollision.response.ok()).toBeFalsy();
    expect(selfCollision.payload.error).toContain(
      "该名称已经是标准店铺名称，无需重复添加为导入别名",
    );
  } finally {
    for (const id of ids.reverse()) {
      await page.request.delete(`/api/store-topic-rules/${id}`);
    }
  }
});

test("ACCEPTED_ALIAS 保留历史名称和页面话题语义且不进入 storeAliases", async ({
  page,
}) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();
  const canonicalName = "Aptamil爱他美海外优选进口超市";
  const historicalAlias = "爱他美优选海外专卖店";
  const temporaryStoreAlias = `上游爱他美店铺${Date.now()}`;
  const getRule = async () => {
    const response = await page.request.get(
      `/api/store-topic-rules?commercePlatform=JD&query=${encodeURIComponent(canonicalName)}&pageSize=10`,
    );
    expect(response.ok()).toBeTruthy();
    return (await response.json()).data.items.find(
      (item: { storeName: string }) => item.storeName === canonicalName,
    ) as {
      id: string;
      enabled: boolean;
      aliases: Array<{ alias: string }>;
      storeAliases: Array<{ alias: string }>;
      acceptedTopics: Array<{ topic: string }>;
    };
  };

  const before = await getRule();
  expect(before.storeAliases).toEqual([]);
  expect(before.aliases.map((alias) => alias.alias)).toContain(historicalAlias);
  expect(before.acceptedTopics.map((topic) => topic.topic)).toContain(
    `#${historicalAlias}`,
  );

  try {
    const addStoreAlias = await page.request.patch(`/api/store-topic-rules/${before.id}`, {
      data: {
        commercePlatform: "JD",
        storeName: canonicalName,
        enabled: before.enabled,
        storeAliases: [{ alias: temporaryStoreAlias }],
      },
    });
    expect(addStoreAlias.ok(), JSON.stringify(await addStoreAlias.json())).toBeTruthy();
    const afterAdd = await getRule();
    expect(afterAdd.storeAliases.map((alias) => alias.alias)).toEqual([
      temporaryStoreAlias,
    ]);
    expect(afterAdd.aliases.map((alias) => alias.alias)).toContain(historicalAlias);
    expect(afterAdd.acceptedTopics.map((topic) => topic.topic)).toContain(
      `#${historicalAlias}`,
    );
    expect(afterAdd.acceptedTopics.map((topic) => topic.topic)).not.toContain(
      `#${temporaryStoreAlias}`,
    );
  } finally {
    const clearStoreAliases = await page.request.patch(
      `/api/store-topic-rules/${before.id}`,
      {
        data: {
          commercePlatform: "JD",
          storeName: canonicalName,
          enabled: before.enabled,
          storeAliases: [],
        },
      },
    );
    expect(clearStoreAliases.ok()).toBeTruthy();
  }

  const afterClear = await getRule();
  expect(afterClear.storeAliases).toEqual([]);
  expect(afterClear.aliases.map((alias) => alias.alias)).toContain(historicalAlias);
  expect(afterClear.acceptedTopics.map((topic) => topic.topic)).toContain(
    `#${historicalAlias}`,
  );
});

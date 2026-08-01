import { expect, test } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";

test("产品阶段话题只显示三组，仅匹配对应的可点击话题", async ({
  page,
}) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  await page.goto("/tasks");
  await expect(page.getByText("产品阶段话题", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "请选择对应的产品阶段话题。产品阶段仅用于匹配对应话题，不要求正文出现段位词。",
      { exact: true },
    ),
  ).toBeVisible();

  const stageSelect = page.getByRole("combobox", {
    name: "产品阶段话题",
  });
  await stageSelect.click();
  const options = page.locator(".ant-select-dropdown:visible .ant-select-item-option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveText("IFFO：P段/1段");
  await expect(options.nth(1)).toHaveText("IFFO：2段");
  await expect(options.nth(2)).toHaveText("GUM：3段/4段/1+段/2+段");
  await expect(page.getByText("新生儿阶段", { exact: true })).toHaveCount(0);
  await expect(page.getByText("二段阶段", { exact: true })).toHaveCount(0);
  await expect(page.getByText("成长阶段", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  );
  expect(campaign).toBeTruthy();

  const disableBodyStageResponse = await page.request.put(
    "/api/rule-stage-groups/IFFO_2",
    {
      data: {
        bodyTerms: ["2段"],
        requireBodyStage: false,
        requiredTopic: "#二段奶粉推荐",
      },
    },
  );
  expect(disableBodyStageResponse.ok()).toBeTruthy();

  const suffix = Date.now();
  const url = `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-passed&stage-topic=${suffix}`;
  const createResponse = await page.request.post("/api/tasks", {
    data: {
      urls: url,
      productId: product.id,
      campaignId: campaign!.id,
      productStage: "IFFO_2",
      skipDuplicates: true,
    },
  });
  expect(createResponse.ok()).toBeTruthy();
  const task = (await createResponse.json()).data.created[0] as {
    id: string;
    productStage: string;
  };
  expect(task.productStage).toBe("IFFO_2");

  const auditResponse = await page.request.post(
    `/api/tasks/${task.id}/audit`,
    { data: { mockCase: "aptamil-stage2-passed" } },
  );
  expect(auditResponse.ok()).toBeTruthy();
  const result = (await auditResponse.json()).data as {
    id: string;
    autoStatus: string;
  };
  expect(result.autoStatus).toBe("PASSED");

  const detailResponse = await page.request.get(`/api/results/${result.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    task: { productStage: string };
    ruleResults: Array<{
      ruleKey: string;
      ruleName: string;
      actualValue: string;
      passed: boolean;
    }>;
  };
  expect(detail.task.productStage).toBe("IFFO_2");
  expect(
    detail.ruleResults.find((item) => item.ruleKey === "PRODUCT_STAGE_BODY"),
  ).toBeUndefined();
  expect(
    detail.ruleResults.find((item) =>
      item.ruleName.includes("产品阶段话题 IFFO：2段"),
    ),
  ).toMatchObject({ passed: true });

  await page.goto(`/results/${result.id}`);
  await expect(page.getByText("产品阶段话题", { exact: true })).toBeVisible();
  await expect(page.getByText("IFFO：2段", { exact: true })).toBeVisible();
  await expect(page.getByText("正文段位校验", { exact: true })).toBeVisible();
  await expect(page.getByText("不参与审核", { exact: true })).toBeVisible();
  await expect(page.getByText("正文允许段位", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("#二段奶粉推荐", { exact: true }).first(),
  ).toBeVisible();

  await page.goto("/rules");
  await expect(
    page.getByText(
      "产品阶段仅用于匹配对应话题，不要求正文出现段位词。标准话题会自动去空格并统一补充 #",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("正文允许段位", { exact: true })).toHaveCount(0);
  await expect(page.getByText("不校验，仅匹配话题").first()).toBeVisible();
});

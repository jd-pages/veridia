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
    {
      data: {
        extraction: {
          url,
          finalUrl: url,
          pageTitle: "爱他美澳洲白金版2段真实体验",
          pageType: "NOTE_DETAIL",
          noteId: `stage-topic-body-${suffix}`,
          title: "爱他美澳洲白金版2段真实体验",
          body: `${"这是一次真实的小红书喂养体验记录".repeat(5)} #爱他美新手爸妈日记 #爱他美澳洲白金版 #二段奶粉推荐`,
          noteType: "IMAGE_TEXT",
          imageExtractionStatus: "SUCCESS",
          imageCount: 2,
          topics: [
            "#爱他美新手爸妈日记",
            "#爱他美澳洲白金版",
            "#二段奶粉推荐",
          ].map((displayText) => ({
            displayText,
            isLinkElement: false,
            hasHref: false,
            href: null,
            textColor: null,
            styleFeature: false,
            domPath: null,
            source: "BODY_VISIBLE_TEXT",
          })),
          pageStatus: "NORMAL",
          isPublic: true,
          extractedAt: new Date().toISOString(),
          adapterName: "playwright-xiaohongshu",
          adapterVersion: "1.4.0",
          technicalWarnings: ["TOPICS_NOT_RECOGNIZED"],
        },
      },
    },
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
  await expect(page).toHaveTitle("VERIDIA");
  await expect(page.getByText("产品阶段话题", { exact: true })).toBeVisible();
  await expect(page.getByText("IFFO：2段", { exact: true })).toBeVisible();
  await expect(page.getByText("正文段位校验", { exact: true })).toHaveCount(0);
  await expect(page.getByText("不参与审核", { exact: true })).toHaveCount(0);
  await expect(page.getByText("15天留存", { exact: true })).toHaveCount(0);
  await expect(page.getByText("作者", { exact: true })).toHaveCount(0);
  await expect(page.getByText("发布时间", { exact: true })).toHaveCount(0);
  await expect(page.getByText("留存计算", { exact: true })).toHaveCount(0);
  await expect(page.getByText("暂无结论", { exact: true })).toHaveCount(0);
  await expect(page.getByText("正文允许段位", { exact: true })).toHaveCount(0);
  await page.getByText("本次使用的规则快照（内部技术字段）").click();
  await expect(page.locator("body")).not.toContainText("发布时间");
  await expect(page.locator("body")).not.toContainText("作者");
  await expect(page.locator("body")).not.toContainText("15天留存");
  await expect(page.locator("body")).not.toContainText("留存计算");
  await expect(page.locator("body")).not.toContainText("暂无结论");
  await expect(
    page.getByText("#二段奶粉推荐", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("阶段话题可点击", { exact: true }).locator("..").getByText("是", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("存在需要人工确认的审核项", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("技术读取失败不会生成内容不合规结论。", {
      exact: true,
    }),
  ).toHaveCount(0);

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

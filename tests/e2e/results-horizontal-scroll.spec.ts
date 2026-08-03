import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

test("审核结果表格悬浮横向滚动、固定列和重算", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "审核结果", exact: true }),
  ).toBeVisible();

  const tableBody = page.locator(".ant-table-body");
  const stickyScroll = page.getByTestId("results-floating-scrollbar");
  const stickyThumb = page.getByTestId("results-floating-scrollbar-thumb");
  const detailsButton = page.getByRole("button", { name: /查看详情/u }).first();
  const moreButton = page.getByRole("button", { name: "更多操作" }).first();

  await expect(detailsButton).toBeVisible();
  await expect(moreButton).toBeVisible();
  const actionLayout = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>(".ant-table-body");
    const action = document.querySelector<HTMLElement>(
      "th.ant-table-cell-fix-right-first",
    );
    const details = document.querySelector<HTMLElement>(
      "button[class*='primaryAction']",
    );
    const more = document.querySelector<HTMLElement>(
      'button[aria-label="更多操作"]',
    );
    const tableRect = table?.getBoundingClientRect();
    return {
      tableRight: tableRect?.right,
      actionRight: action?.getBoundingClientRect().right,
      detailsRight: details?.getBoundingClientRect().right,
      moreRight: more?.getBoundingClientRect().right,
    };
  });
  expect(actionLayout.actionRight).toBeLessThanOrEqual(
    actionLayout.tableRight! + 1,
  );
  expect(actionLayout.detailsRight).toBeLessThanOrEqual(
    actionLayout.tableRight! + 1,
  );
  expect(actionLayout.moreRight).toBeLessThanOrEqual(
    actionLayout.tableRight! + 1,
  );

  const columnWidths = await page.evaluate(() => {
    const widthFor = (title: string) => {
      const cell = [...document.querySelectorAll<HTMLElement>("th")].find(
        (candidate) => candidate.textContent?.trim() === title,
      );
      return cell?.getBoundingClientRect().width;
    };
    return {
      ownership: widthFor("归属信息"),
      topics: widthFor("话题审核"),
      images: widthFor("图片"),
      conclusion: widthFor("审核结论"),
      actions: widthFor("操作"),
    };
  });
  expect(columnWidths.ownership).toBeCloseTo(240, 0);
  expect(columnWidths.topics).toBeCloseTo(180, 0);
  expect(columnWidths.images).toBeCloseTo(120, 0);
  expect(columnWidths.conclusion).toBeCloseTo(250, 0);
  expect(columnWidths.actions).toBeCloseTo(160, 0);

  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const overflow = await tableBody.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeGreaterThan(0);
  await expect(stickyScroll).toBeVisible();

  const scrollTarget = Math.min(300, overflow);
  await tableBody.evaluate((element, target) => {
    element.scrollLeft = target;
    element.dispatchEvent(new Event("scroll"));
  }, scrollTarget);
  await expect
    .poll(() => tableBody.evaluate((element) => element.scrollLeft))
    .toBe(scrollTarget);
  await expect
    .poll(() => stickyThumb.evaluate((element) => element.style.transform))
    .not.toBe("translate3d(0px, 0px, 0px)");

  const thumbBox = await stickyThumb.boundingBox();
  expect(thumbBox).not.toBeNull();
  const beforeDrag = await tableBody.evaluate((element) => element.scrollLeft);
  await stickyThumb.hover();
  await page.mouse.move(
    thumbBox!.x + thumbBox!.width / 2,
    thumbBox!.y + thumbBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    thumbBox!.x + thumbBox!.width / 2 - 120,
    thumbBox!.y + thumbBox!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() => tableBody.evaluate((element) => element.scrollLeft))
    .toBeLessThan(beforeDrag);

  const fixedColumns = await page.evaluate(() => {
    const left = document.querySelector("th.ant-table-cell-fix-left-last");
    const right = document.querySelector("th.ant-table-cell-fix-right-first");
    return {
      leftPosition: left ? getComputedStyle(left).position : "",
      rightPosition: right ? getComputedStyle(right).position : "",
      leftRect: left?.getBoundingClientRect().toJSON(),
      rightRect: right?.getBoundingClientRect().toJSON(),
    };
  });
  expect(fixedColumns.leftPosition).toBe("sticky");
  expect(fixedColumns.rightPosition).toBe("sticky");
  expect(fixedColumns.leftRect!.right).toBeLessThan(
    fixedColumns.rightRect!.left,
  );
  await expect(detailsButton).toBeVisible();
  await expect(moreButton).toBeVisible();

  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await expect(stickyScroll).toBeVisible();

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(stickyScroll).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: /高级筛选/ }).click();
  const reasonFilter = page.getByRole("textbox", {
    name: "不通过原因",
    exact: true,
  });
  await reasonFilter.fill("图片数量不足");
  await page.getByRole("button", { name: /查询/ }).click();
  await expect(
    page.locator(".ant-empty-description, .ant-pagination-total-text").first(),
  ).toBeVisible();
  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  // 过滤后只剩少量行，原生横向滚动条已经位于视口内；此时悬浮条必须隐藏，
  // 避免与原生滚动条重复叠加。
  await expect(stickyScroll).toHaveCount(0);
  await expect
    .poll(() =>
      tableBody.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    )
    .toBeGreaterThan(0);

  await reasonFilter
    .locator("xpath=..")
    .getByRole("button", { name: "close-circle", exact: true })
    .click();
  await page.getByRole("button", { name: /查询/ }).click();
  const pageTwo = page.locator(".ant-pagination-item-2");
  if (await pageTwo.isVisible()) {
    await pageTwo.click();
    await expect(page.locator(".ant-pagination-item-active")).toHaveText("2");
  }
  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const pageTwoLayout = await tableBody.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      overflows: element.scrollWidth - element.clientWidth > 1,
      nativeScrollbarInView: rect.bottom <= window.innerHeight + 12,
    };
  });
  expect(pageTwoLayout.overflows).toBe(true);
  if (pageTwoLayout.nativeScrollbarInView) {
    await expect(stickyScroll).toHaveCount(0);
  } else {
    await expect(stickyScroll).toBeVisible();
  }

  await page.setViewportSize({ width: 1920, height: 1080 });
  const wideLayout = await page.evaluate(() => ({
    pageOverflows:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
    stickyWidth: document
      .querySelector('[data-testid="results-floating-scrollbar"]')
      ?.getBoundingClientRect().width,
    tableWidth: document
      .querySelector(".ant-table-body")
      ?.getBoundingClientRect().width,
  }));
  expect(wideLayout.pageOverflows).toBe(false);
  if (wideLayout.stickyWidth !== undefined) {
    expect(wideLayout.stickyWidth).toBe(wideLayout.tableWidth);
  }
});

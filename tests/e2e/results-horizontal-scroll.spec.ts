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

  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const overflow = await tableBody.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeGreaterThan(0);
  await expect(stickyScroll).toBeVisible();

  await tableBody.evaluate((element) => {
    element.scrollLeft = 600;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => tableBody.evaluate((element) => element.scrollLeft))
    .toBe(600);
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

import { expect, test } from "@playwright/test";

test("话题规则先选择品牌并进入达能详情", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const productsResponse = await page.request.get("/api/products");
  const products = (await productsResponse.json()).data as Array<{
    name: string;
    brandName: string;
  }>;
  expect(
    products
      .filter((product) => product.name.startsWith("爱他美"))
      .every((product) => product.brandName === "达能"),
  ).toBe(true);

  await page.goto("/rules");
  await expect(page.getByRole("heading", { name: "话题规则" })).toBeVisible();
  await expect(page.getByText("达能", { exact: true })).toBeVisible();
  await expect(page.getByText("#爱他美新手爸妈日记")).toHaveCount(0);

  const danoneBrandCard = page.locator(".ant-card").filter({
    has: page.getByText("达能", { exact: true }),
  });
  await expect(danoneBrandCard).toHaveCount(1);
  await danoneBrandCard.getByRole("button", { name: "进入规则" }).click();
  await expect(
    page.getByRole("heading", { name: "达能话题规则" }),
  ).toBeVisible();
  await expect(page.getByText("#爱他美新手爸妈日记")).toBeVisible();
  await expect(page.getByRole("button", { name: "返回品牌列表" })).toBeVisible();
});

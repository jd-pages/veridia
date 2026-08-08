import { expect, test } from "@playwright/test";

test("全局字体从本地静态资源加载且不请求 Google Fonts", async ({ page }) => {
  const googleFontRequests: string[] = [];
  page.on("request", (request) => {
    if (/fonts\.(?:googleapis|gstatic)\.com/iu.test(request.url())) {
      googleFontRequests.push(request.url());
    }
  });

  await page.goto("/login");
  await page.evaluate(() => document.fonts.ready);

  const families = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    heading: getComputedStyle(document.querySelector(".login-story h1")!).fontFamily,
    brand: getComputedStyle(document.querySelector(".login-brand-wordmark span")!).fontFamily,
  }));
  expect(families.body).toContain("Noto Sans SC Variable");
  expect(families.heading).toContain("Noto Serif SC Variable");
  expect(families.brand).toContain("Manrope Variable");

  const localFontResources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /\.(?:woff2?|ttf|otf)(?:\?|$)/iu.test(url)),
  );
  expect(localFontResources.length).toBeGreaterThan(0);
  const appOrigin = new URL(page.url()).origin;
  expect(localFontResources.every((url) => new URL(url).origin === appOrigin)).toBe(true);
  expect(googleFontRequests).toEqual([]);
});

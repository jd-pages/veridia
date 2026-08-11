import { expect, type Page, type Response } from "@playwright/test";

function isRuleUpdateCheck(response: Response) {
  const url = new URL(response.url());
  return (
    response.request().method() === "POST" &&
    url.pathname === "/api/rule-sync/check"
  );
}

export function waitForRuleUpdateCheck(page: Page) {
  return page.waitForResponse(isRuleUpdateCheck);
}

export async function dismissRuleUpdateNoticeIfPresent(
  page: Page,
  checkResponse: Response,
) {
  const payload = (await checkResponse.json().catch(() => null)) as {
    success?: boolean;
    data?: {
      configured?: boolean;
      status?: string;
      latestVersion?: string | null;
    };
  } | null;
  const notice = page
    .locator(".ant-notification-notice")
    .filter({ has: page.getByRole("button", { name: "查看规则更新" }) });
  const updateAvailable = Boolean(
    checkResponse.ok() &&
      payload?.success &&
      payload.data?.configured &&
      payload.data.status === "UPDATE_AVAILABLE" &&
      payload.data.latestVersion,
  );

  if (!updateAvailable) {
    await expect(notice).toHaveCount(0);
    return;
  }

  await expect(notice).toBeVisible();
  const close = notice.locator(".ant-notification-notice-close");
  await expect(close).toBeVisible();
  await close.click();
  await expect(notice).toHaveCount(0);
}

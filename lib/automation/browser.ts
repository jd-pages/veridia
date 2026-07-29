import "server-only";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { prisma } from "@/lib/db";

const SESSION_ID = "xiaohongshu";
const PROFILE_PATH =
  process.env.XHS_PROFILE_PATH || path.join(".playwright", "xhs-profile");
const PROFILE_DIRECTORY = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  PROFILE_PATH,
);

type AutomationBrowserState = {
  workerContext?: BrowserContext;
  loginContext?: BrowserContext;
};

const globalForAutomation = globalThis as typeof globalThis & {
  automationBrowserState?: AutomationBrowserState;
};

const state =
  globalForAutomation.automationBrowserState ??
  (globalForAutomation.automationBrowserState = {});

function persistentOptions(headless: boolean) {
  const channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim();
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  return {
    headless,
    ...(channel ? { channel } : {}),
    ...(executablePath ? { executablePath } : {}),
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 960 },
  };
}

export async function getAutomationSession() {
  return prisma.automationSession.upsert({
    where: { id: SESSION_ID },
    create: {
      id: SESSION_ID,
      platform: "XIAOHONGSHU",
      status: "UNKNOWN",
      profilePath: PROFILE_PATH,
    },
    update: {},
  });
}

export async function getWorkerBrowserContext() {
  if (state.workerContext) return state.workerContext;
  await getAutomationSession();
  state.workerContext = await chromium.launchPersistentContext(
    PROFILE_DIRECTORY,
    persistentOptions(true),
  );
  state.workerContext.once("close", () => {
    state.workerContext = undefined;
  });
  return state.workerContext;
}

export async function closeWorkerBrowserContext() {
  if (!state.workerContext) return;
  await state.workerContext.close().catch(() => undefined);
  state.workerContext = undefined;
}

export async function startXiaohongshuLogin() {
  await closeWorkerBrowserContext();
  if (state.loginContext) {
    const existingPage = state.loginContext.pages()[0];
    if (existingPage) await existingPage.bringToFront();
    return getAutomationSession();
  }

  await getAutomationSession();
  await prisma.automationSession.update({
    where: { id: SESSION_ID },
    data: { status: "LOGIN_IN_PROGRESS", lastError: null },
  });
  state.loginContext = await chromium.launchPersistentContext(
    PROFILE_DIRECTORY,
    persistentOptions(false),
  );
  state.loginContext.once("close", () => {
    state.loginContext = undefined;
  });
  const page = state.loginContext.pages()[0] ?? (await state.loginContext.newPage());
  await page.goto("https://www.xiaohongshu.com/explore", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  return getAutomationSession();
}

export async function completeXiaohongshuLogin() {
  if (!state.loginContext) {
    return prisma.automationSession.update({
      where: { id: SESSION_ID },
      data: {
        status: "LOGIN_REQUIRED",
        lastCheckedAt: new Date(),
        lastError: "专用登录浏览器未打开",
      },
    });
  }

  const page = state.loginContext.pages()[0] ?? (await state.loginContext.newPage());
  const visibleText = await page.locator("body").innerText().catch(() => "");
  const isXiaohongshuPage = (() => {
    try {
      return new URL(page.url()).hostname.endsWith("xiaohongshu.com");
    } catch {
      return false;
    }
  })();
  const loginExpired = /登录后查看|请先登录|登录以继续/.test(visibleText);
  const verificationRequired = /验证码|安全验证|完成验证|滑块验证/.test(
    visibleText,
  );
  if (
    !isXiaohongshuPage ||
    visibleText.trim().length === 0 ||
    loginExpired ||
    verificationRequired
  ) {
    return prisma.automationSession.update({
      where: { id: SESSION_ID },
      data: {
        status: "LOGIN_REQUIRED",
        lastCheckedAt: new Date(),
        lastError: verificationRequired
          ? "仍需手动完成安全验证"
          : isXiaohongshuPage && visibleText.trim().length > 0
            ? "尚未识别到有效登录状态"
            : "无法确认小红书页面已正常加载，请检查网络后重试",
      },
    });
  }

  await state.loginContext.close();
  state.loginContext = undefined;
  return prisma.automationSession.update({
    where: { id: SESSION_ID },
    data: {
      status: "READY",
      lastCheckedAt: new Date(),
      lastLoginAt: new Date(),
      lastError: null,
    },
  });
}

export async function markXiaohongshuLoginRequired(message: string) {
  await closeWorkerBrowserContext();
  return prisma.automationSession.update({
    where: { id: SESSION_ID },
    data: {
      status: "LOGIN_REQUIRED",
      lastCheckedAt: new Date(),
      lastError: message,
    },
  });
}

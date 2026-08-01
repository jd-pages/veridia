import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditTask } from "@prisma/client";
import type { Frame, Page } from "playwright";
import { prisma } from "@/lib/db";
import type { ExtractedNote } from "@/lib/types";
import { getAutomationSession, getWorkerBrowserContext } from "./browser";
import {
  AutomaticExtractionError,
  automaticFailureLabels,
  type AutomaticFailureCode,
} from "./failure";
import {
  detectContentWarnings,
  failureCodeForPageStatus,
} from "./classification";
import {
  classifyAutomaticPage,
  isShortXiaohongshuUrl,
  isXiaohongshuNoteDetailUrl,
  safePageLogUrl,
  type AutomaticPageType,
} from "./page-classification";
import { playwrightAdapters } from "./adapters";

export interface AutomaticExtractionOutcome {
  note: ExtractedNote;
  warnings: AutomaticFailureCode[];
}

interface PageIdentity {
  finalUrl: string;
  pageTitle: string;
  pageType: AutomaticPageType;
  visibleText: string;
}

const KEY_ELEMENT_SELECTOR = [
  "#detail-title",
  "#detail-desc",
  ".note-content",
  "a#hash-tag",
  "a[href*='/search_result']",
].join(",");

function isMockUrl(value: string) {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

function effectiveMockUrl(task: AuditTask) {
  const url = new URL(task.url);
  const retryCase = url.searchParams.get("retryCase");
  if (retryCase && task.attempts > 1) {
    url.searchParams.set("case", retryCase);
  }
  return url.toString();
}

function uniqueUrls(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function throwForPageStatus(status: ExtractedNote["pageStatus"]) {
  const code = failureCodeForPageStatus(status);
  if (code) throw new AutomaticExtractionError(code);
}

async function readPageIdentity(page: Page): Promise<PageIdentity> {
  const finalUrl = page.url();
  const [pageTitle, visibleText] = await Promise.all([
    page.title().catch(() => ""),
    page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => ""),
  ]);
  return {
    finalUrl,
    pageTitle,
    pageType: classifyAutomaticPage({
      url: finalUrl,
      title: pageTitle,
      visibleText,
    }),
    visibleText,
  };
}

async function waitForRedirectCompletion(
  page: Page,
  originalUrl: string,
  redirectChain: string[],
) {
  if (!isShortXiaohongshuUrl(originalUrl)) return;
  const timeout = Number(process.env.AUTOMATION_REDIRECT_TIMEOUT_MS || 15_000);
  const deadline = Date.now() + timeout;
  let previousUrl = "";
  let stableChecks = 0;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    redirectChain.push(currentUrl);
    if (currentUrl === previousUrl) stableChecks += 1;
    else {
      previousUrl = currentUrl;
      stableChecks = 0;
    }
    if (isXiaohongshuNoteDetailUrl(currentUrl) && stableChecks >= 2) return;

    const identity = await readPageIdentity(page);
    if (
      ["LOGIN", "SECURITY_CHECK", "APP_LAUNCH", "ERROR_PAGE"].includes(
        identity.pageType,
      )
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }
}

async function waitForExtractionKeyElements(page: Page) {
  const timeout = Number(
    process.env.AUTOMATION_KEY_ELEMENT_TIMEOUT_MS || 10_000,
  );
  await page
    .locator(KEY_ELEMENT_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout });
  await page.waitForTimeout(250);
}

async function captureFailureEvidence(
  page: Page,
  task: AuditTask,
  identity: PageIdentity,
  redirectChain: string[],
) {
  const evidenceDirectory = process.env.AUTOMATION_EVIDENCE_PATH
    ? path.resolve(process.env.AUTOMATION_EVIDENCE_PATH)
    : path.join(
        /* turbopackIgnore: true */ process.cwd(),
        ".playwright",
        "evidence",
      );
  await mkdir(evidenceDirectory, { recursive: true });
  const fileName = `${task.id}-attempt-${task.attempts}-${Date.now()}.png`;
  const screenshotPath = path.join(evidenceDirectory, fileName);
  const screenshotSaved = await page
    .screenshot({ path: screenshotPath, fullPage: false })
    .then(() => true)
    .catch(() => false);
  const htmlSummary = await page
    .evaluate(
      ({ keySelector }) => {
        const summarize = (selector: string) =>
          [...document.querySelectorAll(selector)].slice(0, 12).map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            className: String(element.className || "").slice(0, 160),
          }));
        return {
          htmlLang: document.documentElement.lang || null,
          bodyTextLength: (document.body?.innerText || "").length,
          bodyChildCount: document.body?.children.length || 0,
          keyElementCount: document.querySelectorAll(keySelector).length,
          keyElements: summarize(keySelector),
          mainLandmarks: summarize(
            "main,article,[role='main'],#noteContainer,.note-container,.note-content",
          ),
        };
      },
      {
        keySelector: KEY_ELEMENT_SELECTOR,
      },
    )
    .catch(() => ({ unavailable: true }));

  return {
    originalUrl: task.url,
    finalUrl: identity.finalUrl,
    pageTitle: identity.pageTitle,
    pageType: identity.pageType,
    redirectChain: uniqueUrls(redirectChain),
    screenshotPath: screenshotSaved
      ? path.relative(process.cwd(), screenshotPath)
      : null,
    htmlSummary,
  };
}

async function savePageMetadata(
  taskId: string,
  identity: PageIdentity,
  redirectChain: string[],
  failureEvidence?: Record<string, unknown> | null,
) {
  await prisma.auditTask.update({
    where: { id: taskId },
    data: {
      finalUrl: identity.finalUrl || null,
      pageTitle: identity.pageTitle || null,
      pageType: identity.pageType,
      redirectChain: JSON.stringify(uniqueUrls(redirectChain)),
      failureEvidence:
        failureEvidence === undefined
          ? undefined
          : failureEvidence
            ? JSON.stringify(failureEvidence)
            : null,
    },
  });
}

function logPageIdentity(task: AuditTask, identity: PageIdentity) {
  console.info(
    "[自动提取页面]",
    JSON.stringify({
      taskId: task.id,
      currentUrl: safePageLogUrl(identity.finalUrl),
      pageTitle: identity.pageTitle,
      pageType: identity.pageType,
    }),
  );
}

export async function extractAuditTaskAutomatically(
  task: AuditTask,
): Promise<AutomaticExtractionOutcome> {
  const mock = isMockUrl(task.url);
  if (!mock) {
    const session = await getAutomationSession();
    if (session.status !== "READY") {
      throw new AutomaticExtractionError(
        "LOGIN_REQUIRED",
        "请先在专用浏览器中登录小红书",
      );
    }
  }

  const context = await getWorkerBrowserContext();
  const page = await context.newPage();
  const pageUrl = mock ? effectiveMockUrl(task) : task.url;
  const redirectChain = [task.url];
  let identity: PageIdentity = {
    finalUrl: pageUrl,
    pageTitle: "",
    pageType: isShortXiaohongshuUrl(pageUrl) ? "SHORT_LINK" : "UNKNOWN",
    visibleText: "",
  };

  const recordNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) redirectChain.push(frame.url());
  };
  page.on("framenavigated", recordNavigation);

  try {
    const url = new URL(pageUrl);
    const simulatedFailure = url.searchParams.get("simulate");
    if (simulatedFailure === "network-error") {
      throw new AutomaticExtractionError("NETWORK_ERROR");
    }
    if (simulatedFailure === "load-timeout") {
      throw new AutomaticExtractionError("LOAD_TIMEOUT");
    }

    let responseUrl = "";
    try {
      const response = await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: Number(process.env.AUTOMATION_PAGE_TIMEOUT_MS || 30_000),
      });
      responseUrl = response?.url() || "";
      if (responseUrl) redirectChain.push(responseUrl);
      await waitForRedirectCompletion(page, task.url, redirectChain);
    } catch (error) {
      if (error instanceof AutomaticExtractionError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message)) {
        throw new AutomaticExtractionError("LOAD_TIMEOUT");
      }
      throw new AutomaticExtractionError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "页面网络请求失败",
      );
    }

    const delay = Number(url.searchParams.get("autoDelay") || 0);
    if (delay > 0) await page.waitForTimeout(Math.min(delay, 10_000));

    identity = await readPageIdentity(page);
    redirectChain.push(identity.finalUrl);
    logPageIdentity(task, identity);

    if (identity.pageType === "LOGIN") {
      throw new AutomaticExtractionError(
        "LOGIN_REQUIRED",
        `页面需要登录：${identity.pageTitle || "无标题"}`,
      );
    }
    if (identity.pageType === "SECURITY_CHECK") {
      throw new AutomaticExtractionError(
        "SECURITY_CHECK",
        `页面要求安全验证：${identity.pageTitle || "无标题"}`,
      );
    }
    if (
      isShortXiaohongshuUrl(task.url) &&
      !isXiaohongshuNoteDetailUrl(identity.finalUrl)
    ) {
      const reason =
        identity.pageType === "APP_LAUNCH"
          ? "短链接进入 App 唤起页"
          : "短链接未跳转到小红书笔记详情页";
      throw new AutomaticExtractionError(
        "REDIRECT_FAILED",
        `${reason}，请人工复核。最终页面：${identity.pageTitle || "无标题"}`,
      );
    }
    if (identity.pageType === "APP_LAUNCH") {
      throw new AutomaticExtractionError(
        "PAGE_READ_FAILED",
        `进入 App 唤起页，无法在网页中提取：${identity.pageTitle || "无标题"}`,
      );
    }

    if (!mock && isXiaohongshuNoteDetailUrl(identity.finalUrl)) {
      try {
        await waitForExtractionKeyElements(page);
      } catch {
        throw new AutomaticExtractionError(
          "STRUCTURE_MISMATCH",
          "笔记详情页未出现正文或话题区域",
        );
      }
    }

    const adapter = playwrightAdapters.find((item) =>
      item.canHandle(identity.finalUrl),
    );
    if (!adapter) {
      throw new AutomaticExtractionError(
        "STRUCTURE_MISMATCH",
        `最终页面没有可用 Adapter：${identity.pageType}`,
      );
    }
    const note = await adapter.extract(page, task.url);
    note.finalUrl = identity.finalUrl;
    note.pageTitle = identity.pageTitle;
    note.pageType = identity.pageType;
    note.redirectChain = uniqueUrls(redirectChain);
    throwForPageStatus(note.pageStatus);

    if (!note.title?.trim() && !note.body?.trim()) {
      throw new AutomaticExtractionError(
        "STRUCTURE_MISMATCH",
        "页面结构已匹配，但没有提取到标题或正文",
      );
    }
    const warnings = detectContentWarnings(note);
    if (!mock && warnings.length) {
      const labels = warnings.map((code) => automaticFailureLabels[code]).join("；");
      throw new AutomaticExtractionError(
        warnings[0],
        `技术读取不完整：${labels}；未生成内容不合规结论`,
      );
    }
    await savePageMetadata(task.id, identity, redirectChain, null);
    return { note, warnings };
  } catch (error) {
    identity = await readPageIdentity(page).catch(() => identity);
    redirectChain.push(identity.finalUrl);
    logPageIdentity(task, identity);
    const extractionError =
      error instanceof AutomaticExtractionError
        ? error
        : new AutomaticExtractionError(
            "PAGE_READ_FAILED",
            error instanceof Error ? error.message : "页面读取失败",
          );
    const evidence = await captureFailureEvidence(
      page,
      task,
      identity,
      redirectChain,
    );
    extractionError.attachDetails(evidence);
    await savePageMetadata(task.id, identity, redirectChain, evidence);
    throw extractionError;
  } finally {
    page.off("framenavigated", recordNavigation);
    await page.close().catch(() => undefined);
  }
}

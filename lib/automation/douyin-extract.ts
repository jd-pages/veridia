import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditTask } from "@prisma/client";
import type { Frame, Page, Request, Response } from "playwright";
import { prisma } from "@/lib/db";
import { AutomaticExtractionError, toAutomaticExtractionError } from "./failure";
import type { AutomaticFailureCode } from "./failure";
import type { AutomaticExtractionOutcome } from "./extract";
import {
  getDouyinAuditPage,
  getDouyinAutomationProfilePath,
  showDouyinManualIntervention,
} from "./douyin-browser";
import {
  douyinContentIdentityFromUrl,
  isDouyinShortUrl,
  readDouyinPageIdentity,
  safeDouyinDiagnosticUrl,
  toWellFormedBrowserText,
} from "./douyin-page-classification";
import {
  findDouyinAwemeItem,
  playwrightDouyinAdapter,
  type DouyinStructuredEvidence,
} from "./douyin-adapter";
import {
  assertPlatformRouting,
  resolveTaskAutomationPlatform,
} from "./platform";

function uniqueValues(values: string[]) {
  return [
    ...new Set(values.filter(Boolean).map(toWellFormedBrowserText)),
  ];
}

function sanitizeDouyinBrowserValue(value: unknown): unknown {
  if (typeof value === "string") return toWellFormedBrowserText(value);
  if (Array.isArray(value)) return value.map(sanitizeDouyinBrowserValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDouyinBrowserValue(item),
      ]),
    );
  }
  return value;
}

function appendRequestChain(request: Request, redirectChain: string[]) {
  const chain: string[] = [];
  let current: Request | null = request;
  while (current) {
    chain.unshift(current.url());
    current = current.redirectedFrom();
  }
  redirectChain.push(...chain);
}

function createDouyinResponseCollector(
  page: Page,
  redirectChain: string[],
) {
  const payloads: Array<Promise<{ payload: unknown; responseUrl: string } | null>> = [];
  const mainDocuments: Array<{ url: string; status: number }> = [];
  const onResponse = (response: Response) => {
    if (
      response.request().resourceType() === "document" &&
      response.frame() === page.mainFrame()
    ) {
      appendRequestChain(response.request(), redirectChain);
      redirectChain.push(response.url());
      mainDocuments.push({ url: response.url(), status: response.status() });
    }
    if (
      /(?:\/aweme\/v1\/web\/aweme\/(?:post|detail)\/?|aweme_detail)/iu.test(
        response.url(),
      )
    ) {
      payloads.push(
        response.json()
          .then((payload) => ({ payload, responseUrl: response.url() }))
          .catch(() => null),
      );
    }
  };
  page.on("response", onResponse);

  return {
    mainDocuments,
    async waitFor(contentId: string, timeoutMs: number): Promise<DouyinStructuredEvidence | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = [...payloads];
        const resolved = await Promise.all(snapshot);
        for (const candidate of resolved) {
          if (!candidate) continue;
          const item = findDouyinAwemeItem(candidate.payload, contentId);
          if (item) {
            return {
              item,
              responseUrl: candidate.responseUrl,
              source: "NETWORK_RESPONSE",
            };
          }
        }
        await page.waitForTimeout(150);
      }
      return null;
    },
    dispose() {
      page.off("response", onResponse);
    },
  };
}

type DouyinNavigationAttempt = {
  url: string;
  ok: boolean;
  status: number | null;
  responseUrl: string | null;
  durationMs: number;
  timedOut: boolean;
  errorName: string | null;
  errorMessage: string | null;
};

async function navigateDouyinPage(
  page: Page,
  url: string,
  timeout: number,
  redirectChain: string[],
) {
  const startedAt = Date.now();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    if (response) {
      appendRequestChain(response.request(), redirectChain);
      redirectChain.push(response.url());
    }
    return {
      response,
      attempt: {
        url: safeDouyinDiagnosticUrl(url),
        ok: true,
        status: response?.status() ?? null,
        responseUrl: response ? safeDouyinDiagnosticUrl(response.url()) : null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        errorName: null,
        errorMessage: null,
      } satisfies DouyinNavigationAttempt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      response: null,
      attempt: {
        url: safeDouyinDiagnosticUrl(url),
        ok: false,
        status: null,
        responseUrl: null,
        durationMs: Date.now() - startedAt,
        timedOut: /timeout/iu.test(message),
        errorName: error instanceof Error ? error.name : null,
        errorMessage: message.slice(0, 1_000),
      } satisfies DouyinNavigationAttempt,
    };
  }
}

async function captureDouyinFailureScreenshot(page: Page, task: AuditTask) {
  const evidenceDirectory = process.env.AUTOMATION_EVIDENCE_PATH
    ? path.resolve(process.env.AUTOMATION_EVIDENCE_PATH)
    : path.join(
        /* turbopackIgnore: true */ process.cwd(),
        ".playwright",
        "evidence",
      );
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshotPath = path.join(
    evidenceDirectory,
    `${task.id}-douyin-attempt-${task.attempts}-${Date.now()}.png`,
  );
  const saved = await page
    .screenshot({ path: screenshotPath, fullPage: false, timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  return saved ? screenshotPath : null;
}

function lastContentIdentity(values: string[]) {
  for (const value of [...values].reverse()) {
    const identity = douyinContentIdentityFromUrl(value);
    if (identity) return identity;
  }
  return null;
}

async function waitForDouyinPageEvidence(page: Page, timeoutMs: number) {
  await Promise.race([
    page.waitForSelector(
      "[data-e2e='note-detail'], [data-testid='douyin-note-detail'], [class*='dySwiper'], [data-testid='douyin-image-carousel'], video",
      {
      state: "attached",
      timeout: timeoutMs,
      },
    ),
    page.waitForFunction(
      () => /你要观看的(?:图文|视频|作品|内容)不存在|安全验证|扫码登录|登录后继续/u.test(
        document.body?.innerText || "",
      ),
      undefined,
      { timeout: timeoutMs },
    ),
  ]).catch(() => undefined);
}

async function saveDouyinPageMetadata(input: {
  taskId: string;
  finalUrl: string | null;
  pageTitle: string | null;
  pageType: string | null;
  redirectChain: string[];
  evidence?: Record<string, unknown> | null;
}) {
  await prisma.auditTask.update({
    where: { id: input.taskId },
    data: {
      finalUrl: input.finalUrl,
      pageTitle: input.pageTitle
        ? toWellFormedBrowserText(input.pageTitle)
        : null,
      pageType: input.pageType,
      redirectChain: JSON.stringify(uniqueValues(input.redirectChain)),
      failureEvidence: input.evidence === undefined
        ? undefined
        : input.evidence
          ? JSON.stringify(sanitizeDouyinBrowserValue(input.evidence))
          : null,
    },
  });
}

export async function extractDouyinAuditTaskAutomatically(
  task: AuditTask,
): Promise<AutomaticExtractionOutcome> {
  assertPlatformRouting({
    taskPlatform: resolveTaskAutomationPlatform(task),
    activePlatform: "DOUYIN",
    browserPlatform: "DOUYIN",
    adapterPlatform: playwrightDouyinAdapter.platform,
    classifierPlatform: "DOUYIN",
  });
  const page = await getDouyinAuditPage({ taskId: task.id, url: task.url });
  const redirectChain: string[] = [task.url];
  const onFrame = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const value = frame.url();
    if (value && redirectChain.at(-1) !== value) redirectChain.push(value);
  };
  const responseCollector = createDouyinResponseCollector(page, redirectChain);
  page.on("framenavigated", onFrame);

  let canonicalUrl: string | null = null;
  let pageTitle: string | null = null;
  let pageType: string | null = isDouyinShortUrl(task.url) ? "SHORT_LINK" : null;
  let httpStatus: number | null = null;
  let structured: DouyinStructuredEvidence | null = null;
  const navigationAttempts: DouyinNavigationAttempt[] = [];
  let identitySnapshot: Awaited<ReturnType<typeof readDouyinPageIdentity>> | null = null;

  try {
    const mockUrl = (() => {
      try {
        const url = new URL(task.url);
        return ["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname.startsWith("/mock/douyin")
          ? url
          : null;
      } catch {
        return null;
      }
    })();
    if (mockUrl?.searchParams.get("case") === "network-error") {
      throw new AutomaticExtractionError("NETWORK_ERROR", "抖音模拟临时网络连接中断");
    }
    if (mockUrl?.searchParams.get("case") === "load-timeout") {
      throw new AutomaticExtractionError("LOAD_TIMEOUT", "抖音模拟页面加载超时");
    }

    const mock = Boolean(mockUrl);
    const navigationTimeout = Math.max(
      500,
      Number(
        process.env.DOUYIN_NAVIGATION_TIMEOUT_MS ||
          (mockUrl?.pathname.endsWith("/stream-timeout")
            ? 500
            : mock ? 15_000 : 45_000),
      ),
    );
    let navigation = await navigateDouyinPage(
      page,
      task.url,
      navigationTimeout,
      redirectChain,
    );
    navigationAttempts.push(navigation.attempt);
    let response = navigation.response;
    httpStatus = response?.status() ?? null;

    let contentIdentity = lastContentIdentity([
      task.url,
      response?.url() || "",
      ...redirectChain,
      page.url(),
    ]);
    if (contentIdentity) {
      canonicalUrl = contentIdentity.canonicalUrl;
      const currentIdentity = douyinContentIdentityFromUrl(page.url());
      if (!currentIdentity || currentIdentity.contentId !== contentIdentity.contentId) {
        navigation = await navigateDouyinPage(
          page,
          canonicalUrl,
          navigationTimeout,
          redirectChain,
        );
        navigationAttempts.push(navigation.attempt);
        response = navigation.response;
        httpStatus = response?.status() ?? httpStatus;
      }
    }

    await waitForDouyinPageEvidence(page, mock ? 2_000 : 10_000);
    httpStatus = httpStatus ?? responseCollector.mainDocuments.at(-1)?.status ?? null;
    contentIdentity = contentIdentity || lastContentIdentity([
      task.url,
      ...redirectChain,
      page.url(),
    ]);
    if (contentIdentity) {
      canonicalUrl = contentIdentity.canonicalUrl;
      structured = await responseCollector.waitFor(
        contentIdentity.contentId,
        mock ? 300 : 10_000,
      );
    }

    const identity = await readDouyinPageIdentity(
      page,
      httpStatus,
      canonicalUrl,
      contentIdentity?.contentId || null,
    );
    identitySnapshot = identity;
    pageTitle = identity.title;
    pageType = identity.pageType;
    console.info("[抖音自动审核] 页面状态", JSON.stringify({
      taskId: task.id,
      originalUrl: safeDouyinDiagnosticUrl(task.url),
      finalUrl: safeDouyinDiagnosticUrl(identity.finalUrl),
      browserUrl: safeDouyinDiagnosticUrl(page.url()),
      pageType: identity.pageType,
      state: identity.state,
      matchedCondition: identity.matchedCondition,
      documentReadyState: identity.documentReadyState,
      bodyLength: identity.bodyLength,
      visibleTextLength: identity.visibleTextLength,
      hasContentEvidence: identity.hasContentEvidence,
      redirectCount: uniqueValues(redirectChain).length,
      structuredEvidence: Boolean(structured),
      navigationAttempts,
    }));

    if (identity.state === "NOT_LOGGED_IN") {
      await showDouyinManualIntervention(page, "LOGIN_REQUIRED");
      throw new AutomaticExtractionError("LOGIN_REQUIRED", "抖音登录状态失效，请完成登录后继续");
    }
    if (identity.state === "SECURITY_RESTRICTED") {
      await showDouyinManualIntervention(page, "SECURITY_RESTRICTED");
      throw new AutomaticExtractionError("SECURITY_VERIFICATION", "抖音要求完成安全验证");
    }
    if (identity.state === "NOTE_NOT_FOUND") {
      throw new AutomaticExtractionError(
        "NOTE_NOT_FOUND",
        "抖音页面提示作品不存在",
        {
          matchedCondition: identity.matchedCondition,
          finalUrl: safeDouyinDiagnosticUrl(identity.finalUrl),
        },
      );
    }
    if (identity.state === "NO_PERMISSION") {
      throw new AutomaticExtractionError("NO_PERMISSION", "当前抖音账号无权查看该作品");
    }
    if (identity.state === "APP_LAUNCH") {
      throw new AutomaticExtractionError("PAGE_READ_FAILED", "抖音页面仅提供 App 唤起，无法读取作品详情");
    }
    if (isDouyinShortUrl(task.url) && !contentIdentity) {
      throw new AutomaticExtractionError("REDIRECT_FAILED", "抖音短链接未跳转到作品详情页");
    }
    if (identity.state !== "NORMAL") {
      const failedNavigation = navigationAttempts.findLast((item) => !item.ok);
      if (failedNavigation) {
        throw new AutomaticExtractionError(
          failedNavigation.timedOut ? "LOAD_TIMEOUT" : "NETWORK_ERROR",
          failedNavigation.timedOut
            ? "抖音作品页面打开超时，需人工确认"
            : "抖音作品页面打开失败，需人工确认",
          { technicalMessage: failedNavigation.errorMessage },
        );
      }
      throw new AutomaticExtractionError("STRUCTURE_MISMATCH", "未识别为抖音作品详情页");
    }

    const extractedNote = await playwrightDouyinAdapter.extract(page, task.url, {
      canonicalUrl,
      contentId: contentIdentity?.contentId || null,
      structured,
    });
    const note = sanitizeDouyinBrowserValue(extractedNote) as typeof extractedNote;
    note.redirectChain = uniqueValues(redirectChain).map(safeDouyinDiagnosticUrl);
    const evidence = {
      ...(note.pageEvidence || {}),
      originalUrl: safeDouyinDiagnosticUrl(task.url),
      finalUrl: safeDouyinDiagnosticUrl(note.finalUrl || canonicalUrl || page.url()),
      browserUrl: safeDouyinDiagnosticUrl(page.url()),
      pageType: note.pageType,
      redirectChain: note.redirectChain,
      contentId: note.noteId || null,
      activePlatform: "DOUYIN",
      browserSessionType: "DOUYIN_PERSISTENT_CONTEXT",
      profilePath: getDouyinAutomationProfilePath(),
      automationAdapter: playwrightDouyinAdapter.name,
      pageClassifier: "classifyDouyinPage",
      pageGoto: navigationAttempts,
      mainDocumentResponses: responseCollector.mainDocuments.map((item) => ({
        ...item,
        url: safeDouyinDiagnosticUrl(item.url),
      })),
      httpStatus,
      documentReadyState: identity.documentReadyState,
      pageTitle: identity.title,
      currentUrl: safeDouyinDiagnosticUrl(identity.currentUrl),
      bodyLength: identity.bodyLength,
      visibleTextLength: identity.visibleTextLength,
      pageStatus: identity.state,
      navigationError: navigationAttempts.findLast((item) => !item.ok) || null,
    };
    note.pageEvidence = evidence;
    await saveDouyinPageMetadata({
      taskId: task.id,
      finalUrl: note.finalUrl || canonicalUrl,
      pageTitle: note.pageTitle || pageTitle,
      pageType: note.pageType || pageType,
      redirectChain: note.redirectChain,
      evidence,
    });
    return {
      note,
      warnings: (note.technicalWarnings || []) as AutomaticFailureCode[],
    };
  } catch (error) {
    let normalized = toAutomaticExtractionError(error);
    if (/timeout/iu.test(normalized.message) && normalized.code === "NETWORK_ERROR") {
      normalized = new AutomaticExtractionError(
        "LOAD_TIMEOUT",
        "抖音作品页面打开超时，需人工确认",
        { ...(normalized.details || {}), technicalMessage: normalized.message },
      );
    } else if (normalized.code === "NETWORK_ERROR") {
      normalized = new AutomaticExtractionError(
        "NETWORK_ERROR",
        "抖音作品页面打开失败，需人工确认",
        { ...(normalized.details || {}), technicalMessage: normalized.message },
      );
    }
    const screenshotPath = await captureDouyinFailureScreenshot(page, task)
      .catch(() => null);
    const navigationError = navigationAttempts.findLast((item) => !item.ok) || null;
    const evidence = {
      ...(normalized.details || {}),
      failureCode: normalized.code,
      failureMessage: normalized.message,
      technicalMessage: normalized.details?.technicalMessage || navigationError?.errorMessage || null,
      originalUrl: safeDouyinDiagnosticUrl(task.url),
      normalizedUrl: safeDouyinDiagnosticUrl(task.normalizedUrl),
      finalUrl: canonicalUrl ? safeDouyinDiagnosticUrl(canonicalUrl) : null,
      browserUrl: safeDouyinDiagnosticUrl(page.url()),
      currentUrl: safeDouyinDiagnosticUrl(page.url()),
      redirectChain: uniqueValues(redirectChain).map(safeDouyinDiagnosticUrl),
      activePlatform: "DOUYIN",
      browserSessionType: "DOUYIN_PERSISTENT_CONTEXT",
      profilePath: getDouyinAutomationProfilePath(),
      automationAdapter: playwrightDouyinAdapter.name,
      pageClassifier: "classifyDouyinPage",
      pageGoto: navigationAttempts,
      mainDocumentResponses: responseCollector.mainDocuments.map((item) => ({
        ...item,
        url: safeDouyinDiagnosticUrl(item.url),
      })),
      httpStatus,
      documentReadyState: identitySnapshot?.documentReadyState || null,
      pageTitle: identitySnapshot?.title || pageTitle,
      bodyLength: identitySnapshot?.bodyLength || 0,
      visibleTextLength: identitySnapshot?.visibleTextLength || 0,
      pageStatus: identitySnapshot?.state || null,
      navigationError,
      screenshotPath,
      detectedAt: new Date().toISOString(),
    };
    normalized.attachDetails(evidence);
    await saveDouyinPageMetadata({
      taskId: task.id,
      finalUrl: canonicalUrl || page.url() || null,
      pageTitle,
      pageType,
      redirectChain: uniqueValues(redirectChain).map(safeDouyinDiagnosticUrl),
      evidence,
    }).catch(() => undefined);
    throw normalized;
  } finally {
    responseCollector.dispose();
    page.off("framenavigated", onFrame);
  }
}

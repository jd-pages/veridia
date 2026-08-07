import "server-only";
import type { AuditTask } from "@prisma/client";
import type { Frame, Page, Request, Response } from "playwright";
import { prisma } from "@/lib/db";
import { AutomaticExtractionError, toAutomaticExtractionError } from "./failure";
import type { AutomaticFailureCode } from "./failure";
import type { AutomaticExtractionOutcome } from "./extract";
import { getDouyinAuditPage, showDouyinManualIntervention } from "./douyin-browser";
import {
  douyinContentIdentityFromUrl,
  isDouyinShortUrl,
  readDouyinPageIdentity,
  safeDouyinDiagnosticUrl,
} from "./douyin-page-classification";
import {
  findDouyinAwemeItem,
  playwrightDouyinAdapter,
  type DouyinStructuredEvidence,
} from "./douyin-adapter";

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
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
  const onResponse = (response: Response) => {
    if (
      response.request().resourceType() === "document" &&
      response.frame() === page.mainFrame()
    ) {
      appendRequestChain(response.request(), redirectChain);
      redirectChain.push(response.url());
    }
    if (/\/aweme\/v1\/web\/aweme\/(?:post|detail)\//iu.test(response.url())) {
      payloads.push(
        response.json()
          .then((payload) => ({ payload, responseUrl: response.url() }))
          .catch(() => null),
      );
    }
  };
  page.on("response", onResponse);

  return {
    async waitFor(contentId: string, timeoutMs: number): Promise<DouyinStructuredEvidence | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = [...payloads];
        const resolved = await Promise.all(snapshot);
        for (const candidate of resolved) {
          if (!candidate) continue;
          const item = findDouyinAwemeItem(candidate.payload, contentId);
          if (item) return { item, responseUrl: candidate.responseUrl };
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

function lastContentIdentity(values: string[]) {
  for (const value of [...values].reverse()) {
    const identity = douyinContentIdentityFromUrl(value);
    if (identity) return identity;
  }
  return null;
}

async function waitForDouyinPageEvidence(page: Page, timeoutMs: number) {
  await Promise.race([
    page.waitForSelector("[data-e2e='note-detail'], video", {
      state: "attached",
      timeout: timeoutMs,
    }),
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
      pageTitle: input.pageTitle,
      pageType: input.pageType,
      redirectChain: JSON.stringify(uniqueValues(input.redirectChain)),
      failureEvidence: input.evidence === undefined
        ? undefined
        : input.evidence ? JSON.stringify(input.evidence) : null,
    },
  });
}

export async function extractDouyinAuditTaskAutomatically(
  task: AuditTask,
): Promise<AutomaticExtractionOutcome> {
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

  try {
    const mockUrl = (() => {
      try {
        const url = new URL(task.url);
        return ["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname === "/mock/douyin"
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
    let response = await page.goto(task.url, {
      waitUntil: "domcontentloaded",
      timeout: mock ? 15_000 : 45_000,
    });
    httpStatus = response?.status() ?? null;
    if (response) {
      appendRequestChain(response.request(), redirectChain);
      redirectChain.push(response.url());
    }

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
        response = await page.goto(canonicalUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        httpStatus = response?.status() ?? httpStatus;
        if (response) {
          appendRequestChain(response.request(), redirectChain);
          redirectChain.push(response.url());
        }
      }
    }

    await waitForDouyinPageEvidence(page, mock ? 2_000 : 10_000);
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
    );
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
      redirectCount: uniqueValues(redirectChain).length,
      structuredEvidence: Boolean(structured),
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
      throw new AutomaticExtractionError("STRUCTURE_MISMATCH", "未识别为抖音作品详情页");
    }

    const note = await playwrightDouyinAdapter.extract(page, task.url, {
      canonicalUrl,
      contentId: contentIdentity?.contentId || null,
      structured,
    });
    note.redirectChain = uniqueValues(redirectChain).map(safeDouyinDiagnosticUrl);
    const evidence = {
      ...(note.pageEvidence || {}),
      originalUrl: safeDouyinDiagnosticUrl(task.url),
      finalUrl: safeDouyinDiagnosticUrl(note.finalUrl || canonicalUrl || page.url()),
      browserUrl: safeDouyinDiagnosticUrl(page.url()),
      pageType: note.pageType,
      redirectChain: note.redirectChain,
      contentId: note.noteId || null,
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
    const normalized = toAutomaticExtractionError(error);
    if (/timeout/iu.test(normalized.message) && normalized.code === "NETWORK_ERROR") {
      throw new AutomaticExtractionError("LOAD_TIMEOUT", "抖音页面加载超时", normalized.details);
    }
    const evidence = {
      ...(normalized.details || {}),
      failureCode: normalized.code,
      originalUrl: safeDouyinDiagnosticUrl(task.url),
      finalUrl: canonicalUrl ? safeDouyinDiagnosticUrl(canonicalUrl) : null,
      browserUrl: safeDouyinDiagnosticUrl(page.url()),
      redirectChain: uniqueValues(redirectChain).map(safeDouyinDiagnosticUrl),
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

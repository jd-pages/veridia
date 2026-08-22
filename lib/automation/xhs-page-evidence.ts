import type { Page, Response } from "playwright";
import type {
  ExtractedTopic,
  ImageExtractionStatus,
  NoteType,
  PageStatus,
} from "@/lib/types";
import { normalizeTopic } from "@/lib/topic";
import { classifyTopicClickability } from "@/lib/topic-clickability";
import {
  parseStructuredPublishedAt,
  parseXhsPublishedAtText,
  type PlatformPublishedAtEvidence,
} from "@/lib/platform-published-at";
import { detectUnavailableXhsPage } from "./page-classification";

export interface TextCandidate {
  value: string;
  source: string;
}

export interface TopicCandidate extends ExtractedTopic {
  source: string;
  evidenceType: "TEXT_HASHTAG_CANDIDATE" | "VERIFIED_PLATFORM_TOPIC";
  contentId?: string | null;
}

export interface ImageCandidate {
  source: string;
  groupKey: string;
  url?: string | null;
  domPath?: string | null;
}

export interface ResponseSummary {
  path: string;
  status: number;
  code?: string | number | null;
  success?: boolean | null;
  message?: string | null;
}

export interface XhsPageCandidates {
  noteIdCandidates: TextCandidate[];
  titleCandidates: TextCandidate[];
  bodyCandidates: TextCandidate[];
  textHashtagCandidates: TopicCandidate[];
  verifiedPlatformTopics: TopicCandidate[];
  imageCandidates: ImageCandidate[];
  publishedAtCandidates: PlatformPublishedAtEvidence[];
  hasVideo: boolean;
  loginEvidence: string[];
  responseSummaries: ResponseSummary[];
}

export interface DomPageSnapshot extends XhsPageCandidates {
  finalUrl: string;
  pageTitle: string;
  visibleTextPreview: string;
  visibleTextLength: number;
  htmlLength: number;
  pageStatus: PageStatus;
  keyElementCount: number;
  domSummary: Array<{
    tag: string;
    id: string | null;
    className: string | null;
  }>;
  domHasVideo: boolean;
  videoEvidence: string[];
  videoCandidateCount: number;
  hasLivePhotoMarker: boolean;
  hasCarouselStructure: boolean;
  carouselPageIndicator: string | null;
  carouselCurrent: number | null;
  carouselTotal: number | null;
}

export interface XhsMediaEvidence {
  domHasVideo: boolean;
  responseHasVideo: boolean;
  videoEvidence: string[];
  videoCandidateCount: number;
  hasLivePhotoMarker: boolean;
  hasCarouselStructure: boolean;
  carouselPageIndicator: string | null;
  carouselTotal: number | null;
  imageCandidateCount: number;
}

export interface XhsMediaDecision {
  noteType: NoteType;
  imageExtractionStatus: ImageExtractionStatus;
  imageCount?: number;
  reason:
    | "IMAGE_CAROUSEL"
    | "IMAGE_MEDIA"
    | "EXPLICIT_VIDEO"
    | "MEDIA_UNKNOWN";
}

export function resolveXhsMediaDecision(
  evidence: XhsMediaEvidence,
): XhsMediaDecision {
  const carouselTotal =
    Number.isInteger(evidence.carouselTotal) && Number(evidence.carouselTotal) >= 2
      ? Number(evidence.carouselTotal)
      : 0;
  const imageCandidateCount = Math.max(0, evidence.imageCandidateCount);
  const hasCarouselEvidence =
    (carouselTotal >= 2 &&
      (evidence.hasCarouselStructure || imageCandidateCount > 0)) ||
    (evidence.hasCarouselStructure && imageCandidateCount > 1);
  const imageCount = Math.max(imageCandidateCount, carouselTotal);

  // LIVE / Live Photo may contain a video element for motion playback. A real
  // image carousel is stronger note-type evidence and must keep image auditing.
  if (hasCarouselEvidence && imageCount > 0) {
    return {
      noteType: "IMAGE_TEXT",
      imageExtractionStatus: "SUCCESS",
      imageCount,
      reason: "IMAGE_CAROUSEL",
    };
  }

  if (
    evidence.domHasVideo ||
    evidence.responseHasVideo ||
    evidence.videoEvidence.length > 0
  ) {
    return {
      noteType: "VIDEO_NOTE",
      imageExtractionStatus: "VIDEO_NOTE",
      reason: "EXPLICIT_VIDEO",
    };
  }

  if (imageCount > 0) {
    return {
      noteType: "IMAGE_TEXT",
      imageExtractionStatus: "SUCCESS",
      imageCount,
      reason: "IMAGE_MEDIA",
    };
  }

  return {
    noteType: "UNKNOWN",
    imageExtractionStatus: "IMAGES_READ_FAILED",
    reason: "MEDIA_UNKNOWN",
  };
}

const HASHTAG_PATTERN = /[#＃]\s*[\p{L}\p{N}_+\-·]{1,60}/gu;
const NOTE_ID_PATTERN = /^[a-f0-9]{16,32}$/iu;

function cleanText(value: unknown, maximum = 10_000) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, maximum);
}

function safeCandidateUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|sign|signature|share|uuid|code|verify|secret|auth/iu.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return value.slice(0, 500);
  }
}

export function safeEvidenceUrl(value: string) {
  return safeCandidateUrl(value);
}

function addTextCandidate(
  target: TextCandidate[],
  value: unknown,
  source: string,
  maximum?: number,
) {
  const cleaned = cleanText(value, maximum);
  if (!cleaned) return;
  if (!target.some((item) => item.value === cleaned)) {
    target.push({ value: cleaned, source });
  }
}

function addTopicsFromText(
  target: TopicCandidate[],
  value: unknown,
  source: string,
  contentId: string | null = null,
) {
  const text = cleanText(value, 100_000);
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    addTopicCandidate(target, {
      displayText: match[0],
      isLinkElement: false,
      hasHref: false,
      href: null,
      textColor: null,
      styleFeature: false,
      domPath: null,
      source,
      evidenceType: "TEXT_HASHTAG_CANDIDATE",
      contentId,
    });
  }
}

function addTopicCandidate(target: TopicCandidate[], candidate: TopicCandidate) {
  const displayText = normalizeTopic(cleanText(candidate.displayText, 100));
  if (!displayText) return;
  const existing = target.find((item) => item.displayText === displayText);
  if (!existing) {
    target.push({
      ...candidate,
      displayText,
      href: candidate.href ? safeCandidateUrl(candidate.href) : null,
    });
    return;
  }
  const score = (item: TopicCandidate) =>
    (classifyTopicClickability(item) === "CLICKABLE" ? 10 : 0) +
    Number(item.isLinkElement) +
    Number(item.hasHref) +
    Number(Boolean(item.href)) +
    Number(item.styleFeature);
  const existingScore = score(existing);
  const candidateScore = score(candidate);
  if (candidateScore > existingScore) {
    Object.assign(existing, candidate, {
      displayText,
      href: candidate.href ? safeCandidateUrl(candidate.href) : null,
    });
  }
}

function addImageCandidate(
  target: ImageCandidate[],
  candidate: ImageCandidate,
) {
  const url = candidate.url ? safeCandidateUrl(candidate.url) : null;
  const key = candidate.groupKey || url || candidate.domPath;
  if (!key) return;
  if (!target.some((item) => item.groupKey === key)) {
    target.push({ ...candidate, url });
  }
}

function addPublishedAtCandidate(
  target: PlatformPublishedAtEvidence[],
  candidate: PlatformPublishedAtEvidence | null,
) {
  if (!candidate) return;
  if (
    !target.some(
      (item) =>
        item.value === candidate.value &&
        item.source === candidate.source &&
        item.contentId === candidate.contentId,
    )
  ) {
    target.push(candidate);
  }
}

function structuredNoteId(record: Record<string, unknown>, path: string[]) {
  const explicit = [record.note_id, record.noteId, record.target_note_id]
    .map((value) => String(value ?? "").trim())
    .find((value) => NOTE_ID_PATTERN.test(value));
  if (explicit) return explicit;
  const id = String(record.id ?? "").trim();
  return NOTE_ID_PATTERN.test(id) && path.some((item) => /note|card|item/iu.test(item))
    ? id
    : null;
}

function isExcludedTopicPath(path: string[]) {
  return path.some((item) =>
    /comment|comments|recommend|related|suggest|reply/iu.test(item),
  );
}

function addStructuredPublishedAtCandidates(
  target: PlatformPublishedAtEvidence[],
  record: Record<string, unknown>,
  noteId: string | null,
  source: string,
) {
  if (!noteId) return;
  for (const key of [
    "create_time",
    "createTime",
    "publish_time",
    "publishTime",
    "timestamp",
    "time",
  ]) {
    addPublishedAtCandidate(
      target,
      parseStructuredPublishedAt(
        record[key],
        `${source}:${key}`,
        noteId,
      ),
    );
  }
}

export function createEmptyCandidates(): XhsPageCandidates {
  return {
    noteIdCandidates: [],
    titleCandidates: [],
    bodyCandidates: [],
    textHashtagCandidates: [],
    verifiedPlatformTopics: [],
    imageCandidates: [],
    publishedAtCandidates: [],
    hasVideo: false,
    loginEvidence: [],
    responseSummaries: [],
  };
}

export function noteIdCandidatesFromUrls(values: string[]) {
  const candidates: TextCandidate[] = [];
  for (const value of values) {
    try {
      const parsed = new URL(value);
      const pathMatch = parsed.pathname.match(
        /\/(?:explore|discovery\/item)\/([a-z0-9]+)/iu,
      );
      if (pathMatch?.[1]) {
        addTextCandidate(candidates, pathMatch[1], "URL_PATH", 100);
      }
      for (const key of ["target_note_id", "note_id", "noteId"]) {
        addTextCandidate(candidates, parsed.searchParams.get(key), "URL_QUERY", 100);
      }
    } catch {
      // Invalid URL is handled by the calling navigation layer.
    }
  }
  return candidates;
}

export function collectJsonCandidates(
  payload: unknown,
  source = "PAGE_JSON",
): XhsPageCandidates {
  const result = createEmptyCandidates();
  const visited = new Set<object>();
  let visitedNodes = 0;

  const visit = (
    value: unknown,
    path: string[],
    parentKey = "",
    boundNoteId: string | null = null,
  ) => {
    if (visitedNodes >= 20_000 || value === null || value === undefined) return;
    visitedNodes += 1;

    if (typeof value === "string") {
      const key = parentKey.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        ["noteid", "targetnoteid"].includes(key) ||
        (key === "id" && path.some((item) => /note|card/i.test(item)))
      ) {
        if (NOTE_ID_PATTERN.test(value)) {
          addTextCandidate(result.noteIdCandidates, value, source, 100);
        }
      }
      if (["title", "displaytitle", "notetitle"].includes(key)) {
        addTextCandidate(result.titleCandidates, value, source, 500);
      }
      if (["desc", "description", "content", "notetext"].includes(key)) {
        addTextCandidate(result.bodyCandidates, value, source);
        addTopicsFromText(
          result.textHashtagCandidates,
          value,
          source,
          boundNoteId,
        );
      }
      if (/^(?:tag|tags|taglist|topic|topics|hashtag|hashtags|challenge|challenges|chalist)$/u.test(key)) {
        const normalized = normalizeTopic(value);
        if (boundNoteId && normalized && !isExcludedTopicPath(path)) {
          addTopicCandidate(result.verifiedPlatformTopics, {
            displayText: normalized,
            isClickable: true,
            isLinkElement: false,
            hasHref: false,
            href: null,
            textColor: null,
            styleFeature: false,
            domPath: null,
            source: `STRUCTURED_PLATFORM_TOPIC:${source}`,
            evidenceType: "VERIFIED_PLATFORM_TOPIC",
            contentId: boundNoteId,
          });
        }
      }
      if (/url|src/.test(key) && /^https?:\/\//iu.test(value)) {
        if (path.some((item) => /image|cover|media|pic/iu.test(item))) {
          addImageCandidate(result.imageCandidates, {
            source,
            groupKey: `${source}:${path.slice(0, -1).join(".")}`,
            url: value,
          });
        }
      }
      return;
    }
    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.slice(0, 200).forEach((item, index) =>
        visit(item, [...path, String(index)], parentKey, boundNoteId),
      );
      return;
    }

    const record = value as Record<string, unknown>;
    const recordNoteId =
      structuredNoteId(record, path) ||
      (typeof record.id === "string" &&
      NOTE_ID_PATTERN.test(record.id) &&
      Boolean(record.note_card || record.noteCard)
        ? record.id
        : null);
    const effectiveNoteId = recordNoteId || boundNoteId;
    addStructuredPublishedAtCandidates(
      result.publishedAtCandidates,
      record,
      effectiveNoteId,
      source,
    );
    const nestedNote = (record.note_card || record.noteCard) as
      | Record<string, unknown>
      | undefined;
    if (nestedNote && typeof nestedNote === "object" && !Array.isArray(nestedNote)) {
      addStructuredPublishedAtCandidates(
        result.publishedAtCandidates,
        nestedNote,
        structuredNoteId(nestedNote, [...path, "note_card"]) ||
          (typeof record.id === "string" && NOTE_ID_PATTERN.test(record.id)
            ? record.id
            : recordNoteId),
        source,
      );
    }
    if (
      typeof record.id === "string" &&
      (record.note_card || record.noteCard) &&
      NOTE_ID_PATTERN.test(record.id)
    ) {
      addTextCandidate(result.noteIdCandidates, record.id, source, 100);
    }
    const typeValue = cleanText(record.type || record.noteType, 50).toLowerCase();
    if (typeValue.includes("video")) result.hasVideo = true;

    const topicText =
      record.name || record.title || record.topic || record.tag || record.text;
    if (
      path.some((item) => /tag|topic|hashtag|challenge|cha_list/iu.test(item)) &&
      !isExcludedTopicPath(path) &&
      typeof topicText === "string"
    ) {
      const displayText = topicText.trim().startsWith("#")
        ? topicText.trim()
        : `#${topicText.trim()}`;
      const hrefValue = cleanText(record.href || record.url || record.link, 1_000);
      if (effectiveNoteId) addTopicCandidate(result.verifiedPlatformTopics, {
        displayText,
        isClickable: true,
        isLinkElement: Boolean(hrefValue),
        hasHref: Boolean(hrefValue),
        href: hrefValue || null,
        textColor: null,
        styleFeature: Boolean(hrefValue),
        domPath: null,
        source: `STRUCTURED_PLATFORM_TOPIC:${source}`,
        evidenceType: "VERIFIED_PLATFORM_TOPIC",
        contentId: effectiveNoteId,
      });
    }

    for (const [key, child] of Object.entries(record)) {
      visit(child, [...path, key], key, effectiveNoteId);
    }
  };

  visit(payload, [], "");
  return result;
}

export function mergeCandidates(...items: XhsPageCandidates[]) {
  const merged = createEmptyCandidates();
  for (const item of items) {
    for (const candidate of item.noteIdCandidates) {
      addTextCandidate(
        merged.noteIdCandidates,
        candidate.value,
        candidate.source,
        100,
      );
    }
    for (const candidate of item.titleCandidates) {
      addTextCandidate(
        merged.titleCandidates,
        candidate.value,
        candidate.source,
        500,
      );
    }
    for (const candidate of item.bodyCandidates) {
      addTextCandidate(
        merged.bodyCandidates,
        candidate.value,
        candidate.source,
      );
    }
    for (const candidate of item.textHashtagCandidates) {
      addTopicCandidate(merged.textHashtagCandidates, candidate);
    }
    for (const candidate of item.verifiedPlatformTopics) {
      addTopicCandidate(merged.verifiedPlatformTopics, candidate);
    }
    for (const candidate of item.imageCandidates) {
      addImageCandidate(merged.imageCandidates, candidate);
    }
    for (const candidate of item.publishedAtCandidates) {
      addPublishedAtCandidate(merged.publishedAtCandidates, candidate);
    }
    merged.hasVideo ||= item.hasVideo;
    for (const evidence of item.loginEvidence) {
      if (!merged.loginEvidence.includes(evidence)) {
        merged.loginEvidence.push(evidence);
      }
    }
    for (const summary of item.responseSummaries) {
      if (
        !merged.responseSummaries.some(
          (item) =>
            item.path === summary.path &&
            item.status === summary.status &&
            item.code === summary.code,
        )
      ) {
        merged.responseSummaries.push(summary);
      }
    }
  }
  return merged;
}

export function verifiedTopicsForCurrentNote(
  candidates: XhsPageCandidates,
  currentNoteId: string | null,
) {
  if (!currentNoteId) return [];
  return candidates.verifiedPlatformTopics
    .filter(
      (topic) =>
        topic.source.startsWith("DOM_") || topic.contentId === currentNoteId,
    )
    .map((topic) => ({
      ...topic,
      isClickable: true,
      contentId: topic.contentId || currentNoteId,
    }));
}

function responseMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return cleanText(record.msg || record.message || record.error, 300) || null;
}

function responseCode(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).code;
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function responseSuccess(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).success;
  return typeof value === "boolean" ? value : null;
}

export function createXhsResponseCollector(page: Page) {
  let candidates = createEmptyCandidates();
  const pending = new Set<Promise<void>>();
  const handler = (response: Response) => {
    const work = (async () => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(response.url());
      } catch {
        return;
      }
      if (!parsedUrl.hostname.endsWith("xiaohongshu.com")) return;
      if (!/\/api\/sns\/web\/v1\/(?:feed|note|search|login)/iu.test(parsedUrl.pathname)) {
        return;
      }
      const contentType = response.headers()["content-type"] || "";
      if (!contentType.includes("json")) return;
      const payload = await response.json().catch(() => null);
      if (!payload) return;
      const summary: ResponseSummary = {
        path: parsedUrl.pathname,
        status: response.status(),
        code: responseCode(payload),
        success: responseSuccess(payload),
        message: responseMessage(payload),
      };
      const jsonCandidates = collectJsonCandidates(payload, "NETWORK_JSON");
      jsonCandidates.responseSummaries.push(summary);
      if (
        summary.status === 401 ||
        summary.status === 403 ||
        /无登录信息|登录后|请先登录|登录已过期/iu.test(summary.message || "")
      ) {
        jsonCandidates.loginEvidence.push(
          `接口 ${summary.path}：${summary.message || `HTTP ${summary.status}`}`,
        );
      }
      if (
        summary.status === 461 ||
        /安全|风险|验证|限制/iu.test(summary.message || "")
      ) {
        jsonCandidates.loginEvidence.push(
          `安全限制 ${summary.path}：${summary.message || `HTTP ${summary.status}`}`,
        );
      }
      candidates = mergeCandidates(candidates, jsonCandidates);
    })().finally(() => pending.delete(work));
    pending.add(work);
  };
  page.on("response", handler);
  return {
    async snapshot() {
      await Promise.allSettled([...pending]);
      return candidates;
    },
    dispose() {
      page.off("response", handler);
    },
  };
}

export async function collectDomPageSnapshot(
  page: Page,
): Promise<DomPageSnapshot> {
  const snapshot = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const html = document.documentElement?.outerHTML || "";
    const excluded = [
      "header",
      "nav",
      "footer",
      "[class*='comment']",
      "[class*='recommend']",
      "[class*='related']",
      "[class*='avatar']",
    ].join(",");
    const rootSelectors = [
      "#noteContainer",
      "[data-testid='note-detail']",
      ".note-detail-mask",
      "[class*='note-detail']",
      "article",
      ".note-content",
      "[class*='note-content']",
    ];
    const roots = rootSelectors.flatMap((selector) => [
      ...document.querySelectorAll(selector),
    ]);
    const uniqueElements = (selectors: string[]) => {
      const seen = new Set<Element>();
      const result: Element[] = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (!seen.has(element) && !element.closest(excluded)) {
            seen.add(element);
            result.push(element);
          }
        }
      }
      return result;
    };
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const elementPath = (element: Element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const classes = [...element.classList]
        .slice(0, 3)
        .map((item) => `.${CSS.escape(item)}`)
        .join("");
      return `${element.tagName.toLowerCase()}${classes}`;
    };
    const absoluteUrl = (value: string) => {
      try {
        const base = /^https?:/iu.test(location.href)
          ? location.href
          : "https://www.xiaohongshu.com/";
        return new URL(value, base).href;
      } catch {
        return value;
      }
    };
    const textCandidates = (selectors: string[], source: string) =>
      uniqueElements(selectors)
        .filter(visible)
        .map((element) => ({
          value: (element.textContent || "").trim(),
          source: `${source}:${elementPath(element)}`,
        }))
        .filter((item) => item.value);

    const titleCandidates = textCandidates(
      [
        "#detail-title",
        "[data-testid='note-title']",
        "[class*='note-title']",
        "[class*='note-content'] [class*='title']",
        "[class*='note-detail'] [class*='title']",
      ],
      "DOM",
    );
    const bodyCandidates = textCandidates(
      [
        "#detail-desc",
        "[data-testid='note-content']",
        "[data-testid='note-desc']",
        "[class*='note-desc']",
        "[class*='note-content'] [class*='desc']",
        "[class*='note-detail'] [class*='desc']",
        "article [class*='content']",
      ],
      "DOM",
    );

    const mainNoteRoot = roots.find(visible) || null;
    const publicationPattern = /^(?:(?:编辑于|发布于)\s*)?(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|昨天\s*\d{1,2}:\d{2}(?::\d{2})?|\d{1,4}天前|\d{1,6}小时前|\d{1,6}分钟前)(?:\s+(?:IP属地[：:]?\s*)?[\p{Script=Han}]{2,12})?$/u;
    const descriptionElement = mainNoteRoot?.querySelector(
      "#detail-desc,[data-testid='note-content'],[data-testid='note-desc'],[class*='note-desc'],[class*='note-content'] [class*='desc']",
    );
    const commentElement = mainNoteRoot?.querySelector(
      "[data-testid*='comment'],[class*='comment']",
    );
    const isCurrentNoteMetadataNode = (element: Element) => {
      if (!visible(element) || element.closest(excluded)) return false;
      if (
        descriptionElement &&
        !(descriptionElement.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        return false;
      }
      if (
        commentElement &&
        !(element.compareDocumentPosition(commentElement) &
          Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        return false;
      }
      return publicationPattern.test((element.textContent || "").replace(/\s+/gu, " ").trim());
    };
    const explicitPublicationNodes = mainNoteRoot
      ? [
          ...mainNoteRoot.querySelectorAll(
            "[data-xhs-published-text],[data-testid='note-publish-time'],[data-testid*='publish-time'],time,[class*='publish-time'],[class*='publish-date'],[class*='note-time'],[class*='date']",
          ),
        ]
      : [];
    const explicitPublicationSet = new Set(explicitPublicationNodes);
    // The current XHS detail page may render platform time as an otherwise
    // unlabelled leaf span below the note description. Scan only the current
    // note metadata interval and require the complete leaf text to match.
    const fallbackPublicationNodes = mainNoteRoot
      ? [...mainNoteRoot.querySelectorAll("span,div,p,time")].filter(
          (element) =>
            !explicitPublicationSet.has(element) &&
            !element.querySelector("span,div,p,time") &&
            isCurrentNoteMetadataNode(element),
        )
      : [];
    const fallbackPublicationSet = new Set(fallbackPublicationNodes);
    const publicationNodes = [
      ...new Set([...explicitPublicationNodes, ...fallbackPublicationNodes]),
    ];
    const publishedAtTextCandidates = publicationNodes
      .filter(isCurrentNoteMetadataNode)
      .map((element) => ({
        raw: (element.textContent || "").replace(/\s+/gu, " ").trim(),
        source: `${fallbackPublicationSet.has(element) ? "DOM_MAIN_NOTE_METADATA_FALLBACK" : "DOM_MAIN_NOTE"}:${elementPath(element)}`,
      }))
      .filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.raw === item.raw && candidate.source === item.source,
          ) === index,
      );

    for (const root of roots.filter(visible)) {
      const candidates = [...root.querySelectorAll("p,div,span")]
        .filter((element) => !element.closest(excluded) && visible(element))
        .map((element) => ({
          value: (element.textContent || "").trim(),
          source: `DOM_FALLBACK:${elementPath(element)}`,
        }))
        .filter((item) => item.value.length >= 20 && item.value.length <= 10_000)
        .sort((left, right) => right.value.length - left.value.length);
      if (candidates[0]) bodyCandidates.push(candidates[0]);
    }

    const metaTitle =
      document.querySelector<HTMLMetaElement>("meta[property='og:title']")
        ?.content || "";
    const metaDescription =
      document.querySelector<HTMLMetaElement>(
        "meta[property='og:description'],meta[name='description']",
      )?.content || "";
    if (metaTitle && !/^小红书\s*[-·]/u.test(metaTitle)) {
      titleCandidates.push({ value: metaTitle, source: "META" });
    }
    if (metaDescription && !/^小红书/u.test(metaDescription)) {
      bodyCandidates.push({ value: metaDescription, source: "META" });
    }
    const detailLikePage =
      roots.length > 0 ||
      /\/(?:explore|discovery\/item)\/[a-z0-9]+/iu.test(location.pathname);
    if (!bodyCandidates.length && detailLikePage) {
      const fallbackLine = text
        .split(/\n+/)
        .map((item) => item.trim())
        .filter(
          (item) =>
            item.length >= 20 &&
            !/ICP备|营业执照|用户协议|隐私政策|创作中心|业务合作/u.test(item),
        )
        .sort((left, right) => right.length - left.length)[0];
      if (fallbackLine) {
        bodyCandidates.push({ value: fallbackLine, source: "VISIBLE_TEXT_FALLBACK" });
      }
    }

    const scopedTopicElements = (selectors: string[]) => {
      if (!mainNoteRoot) return [] as Element[];
      const seen = new Set<Element>();
      const elements: Element[] = [];
      for (const selector of selectors) {
        const matches = [
          ...(mainNoteRoot.matches(selector) ? [mainNoteRoot] : []),
          ...mainNoteRoot.querySelectorAll(selector),
        ];
        for (const element of matches) {
          if (
            !seen.has(element) &&
            !element.closest(excluded) &&
            visible(element)
          ) {
            seen.add(element);
            elements.push(element);
          }
        }
      }
      return elements;
    };
    const topicElements = scopedTopicElements([
      "#hash-tag",
      "a[href*='/search_result']",
      "a[href*='/search']",
      "a[href*='keyword=']",
      "a[href*='/topic']",
      "a[href*='hashtag']",
      "[data-testid*='hashtag']",
      "[data-topic-id]",
      "[data-topic-name]",
      "[data-topic]",
      "[data-xhs-topic]",
      "[class*='hashtag']",
      "[class*='topic']",
    ]);
    for (const anchor of scopedTopicElements(["a"])) {
      if (/[#＃]/u.test(anchor.textContent || "")) topicElements.push(anchor);
    }
    const verifiedPlatformTopics: Array<{
      displayText: string;
      isClickable: boolean;
      isLinkElement: boolean;
      hasHref: boolean;
      href: string | null;
      textColor: string | null;
      styleFeature: boolean;
      domPath: string | null;
      source: string;
      evidenceType: "VERIFIED_PLATFORM_TOPIC";
      contentId: null;
    }> = topicElements
      .filter((element, index, all) => all.indexOf(element) === index)
      .flatMap((element) => {
        const interactiveSelector = [
          "a[href]",
          "button",
          "[role='link']",
          "[role='button']",
          "[tabindex]",
          "[onclick]",
          "#hash-tag",
          "[data-topic-id]",
          "[data-topic-name]",
          "[data-topic]",
          "[data-xhs-topic]",
        ].join(",");
        const interactive = element.closest(interactiveSelector) || element;
        if (!mainNoteRoot?.contains(interactive)) return [];
        const elementText = (interactive.textContent || element.textContent || "")
          .replace(/\s+/gu, "")
          .trim();
        const topics =
          elementText.match(/[#＃]\s*[\p{L}\p{N}_+\-·]{1,60}/gu) || [];
        const href = interactive.getAttribute("href");
        const style = getComputedStyle(interactive);
        const isLinkElement =
            interactive.tagName.toLowerCase() === "a" ||
            interactive.tagName.toLowerCase() === "button" ||
            ["link", "button"].includes(interactive.getAttribute("role") || "") ||
            interactive.hasAttribute("onclick") ||
            (interactive as HTMLElement).tabIndex >= 0;
        const hasHref = Boolean(href && !href.startsWith("javascript:"));
        const hrefValue = href ? absoluteUrl(href) : null;
        const platformTopicSemantics = Boolean(
          hrefValue &&
            /(?:search(?:_result)?|keyword=|\/topic|hashtag|tag)/iu.test(
              hrefValue,
            ),
        );
        const platformTopicAttribute =
          interactive.id === "hash-tag" ||
          interactive.hasAttribute("data-topic-id") ||
          interactive.hasAttribute("data-topic-name") ||
          interactive.hasAttribute("data-topic") ||
          interactive.hasAttribute("data-xhs-topic") ||
          /hashtag|topic/iu.test(interactive.getAttribute("data-testid") || "");
        const platformTopicClass = /(?:^|[\s_-])(?:hash-?tag|topic)(?:[\s_-]|$)/iu.test(
          interactive.getAttribute("class") || "",
        );
        const delegatedPlatformInteraction =
          platformTopicAttribute ||
          (platformTopicClass &&
            (isLinkElement || style.cursor === "pointer"));
        if (
          !platformTopicSemantics &&
          !delegatedPlatformInteraction
        ) {
          return [];
        }
        return topics.map((displayText) => ({
          displayText,
          isClickable: true,
          isLinkElement: isLinkElement || delegatedPlatformInteraction,
          hasHref,
          href: hrefValue,
          textColor: style.color || null,
          styleFeature:
            style.cursor === "pointer" ||
            interactive.matches("[class*='topic'],[class*='hashtag'],#hash-tag"),
          domPath: elementPath(interactive),
          source: hasHref ? "DOM_LINK" : "DOM_INTERACTIVE",
          evidenceType: "VERIFIED_PLATFORM_TOPIC" as const,
          contentId: null,
        }));
      });

    const candidateText = bodyCandidates.map((item) => item.value).join("\n");
    const textHashtagCandidates: Array<{
      displayText: string;
      isLinkElement: boolean;
      hasHref: boolean;
      href: null;
      textColor: null;
      styleFeature: boolean;
      domPath: null;
      source: string;
      evidenceType: "TEXT_HASHTAG_CANDIDATE";
      contentId: null;
    }> = [];
    for (const displayText of candidateText.match(/[#＃]\s*[\p{L}\p{N}_+\-·]{1,60}/gu) || []) {
      textHashtagCandidates.push({
        displayText,
        isLinkElement: false,
        hasHref: false,
        href: null,
        textColor: null,
        styleFeature: false,
        domPath: null,
        source: "VISIBLE_TEXT",
        evidenceType: "TEXT_HASHTAG_CANDIDATE",
        contentId: null,
      });
    }

    const mediaRoots = uniqueElements([
      "[data-testid='note-media']",
      "[class*='note-slider']",
      "[class*='carousel']",
      "[class*='swiper']",
      "[class*='media-container']",
      "[class*='note-detail'] [class*='media']",
      "[class*='note-detail'] [class*='image']",
      "article [class*='image']",
      "video",
    ]);
    const carouselElements = mediaRoots.flatMap((root) => [
      ...(root.matches(
        "[data-swiper-slide-index],[class*='swiper'],[class*='carousel'],[class*='note-slider']",
      )
        ? [root]
        : []),
      ...root.querySelectorAll(
        "[data-swiper-slide-index],[class*='swiper-slide'],[class*='carousel-item'],[class*='slide-item']",
      ),
    ]);
    const hasCarouselStructure = carouselElements.length > 0;
    const indicatorTexts = mediaRoots.flatMap((root) => [
      root.textContent || "",
      ...[...root.querySelectorAll(
        "[class*='pagination'],[class*='indicator'],[class*='counter'],[data-testid*='pagination'],[aria-label*='图片'],[aria-label*='轮播']",
      )].map((element) => element.textContent || element.getAttribute("aria-label") || ""),
    ]);
    let carouselPageIndicator: string | null = null;
    let carouselCurrent: number | null = null;
    let carouselTotal: number | null = null;
    for (const indicatorText of indicatorTexts) {
      for (const match of indicatorText.matchAll(
        /(?:^|[^\d])(\d{1,3})\s*\/\s*(\d{1,3})(?!\d)/gu,
      )) {
        const current = Number(match[1]);
        const total = Number(match[2]);
        if (current < 1 || total < 2 || current > total || total > 100) continue;
        if (carouselTotal === null || total > carouselTotal) {
          carouselCurrent = current;
          carouselTotal = total;
          carouselPageIndicator = `${current}/${total}`;
        }
      }
    }
    const livePhotoElements = [
      ...new Set(
        mediaRoots.flatMap((root) => [
          ...(root.matches("[class*='live'],[data-testid*='live']")
            ? [root]
            : []),
          ...root.querySelectorAll("[class*='live'],[data-testid*='live']"),
        ]),
      ),
    ];
    const hasLivePhotoMarker = livePhotoElements.some((element) =>
      /(?:^|\s)(?:LIVE|Live\s*Photo|实况(?:图)?|动态图片)(?:\s|$)/u.test(
        (element.textContent || element.getAttribute("aria-label") || "").trim(),
      ),
    );
    const videoElements = [
      ...new Set(
        mediaRoots.flatMap((root) => [
          ...(root.matches("video") ? [root] : []),
          ...root.querySelectorAll("video"),
        ]),
      ),
    ];
    const videoEvidence: string[] = [];
    if (videoElements.length > 0) videoEvidence.push("VIDEO_ELEMENT");
    if (
      videoElements.some((element) =>
        [
          element.getAttribute("src"),
          element.getAttribute("data-src"),
          ...[...element.querySelectorAll("source")].map((source) =>
            source.getAttribute("src"),
          ),
        ].some((value) => /\.(?:mp4|m3u8|mov)(?:[?#]|$)/iu.test(value || "")),
      )
    ) {
      videoEvidence.push("VIDEO_STREAM");
    }
    if (
      videoElements.some(
        (element) =>
          element.hasAttribute("controls") ||
          element.hasAttribute("autoplay") ||
          element.hasAttribute("muted"),
      )
    ) {
      videoEvidence.push("VIDEO_ATTRIBUTES");
    }
    if (
      mediaRoots.some(
        (element) =>
          element.matches("[class*='video-player'],[data-testid*='video-player']") ||
          Boolean(
            element.querySelector(
              "[class*='video-player'],[data-testid*='video-player']",
            ),
          ),
      )
    ) {
      videoEvidence.push("VIDEO_PLAYER");
    }
    if (
      mediaRoots.some((element) =>
        /(?:^|\s)\d{1,2}:\d{2}(?:\s|$)/u.test(element.textContent || ""),
      )
    ) {
      videoEvidence.push("VIDEO_DURATION");
    }
    if (
      mediaRoots.some((element) =>
        Boolean(
          element.querySelector(
            "[aria-label*='播放'],[title*='播放'],button[class*='play']",
          ),
        ),
      )
    ) {
      videoEvidence.push("VIDEO_PLAY_CONTROL");
    }
    const hasVideo = videoEvidence.length > 0;
    const imageCandidates: Array<{
      source: string;
      groupKey: string;
      url?: string | null;
      domPath?: string | null;
    }> = [];
    const imageNodes = mediaRoots.flatMap((root) => [
      ...(root.matches("img,picture,source,[style*='background-image']")
        ? [root]
        : []),
      ...root.querySelectorAll(
        "img,picture,source,[data-src],[data-original],[data-lazy-src],[srcset],[style*='background-image']",
      ),
    ]);
    const stableMediaKey = (value: string) => {
      if (
        !value ||
        /^(?:data:|blob:)/iu.test(value) ||
        /(?:placeholder|loading|spacer|transparent|avatar|emoji|icon)/iu.test(
          value,
        )
      ) {
        return "";
      }
      try {
        const parsed = new URL(value, location.href);
        parsed.hash = "";
        parsed.search = "";
        parsed.pathname = parsed.pathname
          .replace(/![^/]+$/u, "")
          .replace(/(?:_|-)\d{2,4}x\d{1,4}(?=\.[a-z0-9]+$)/iu, "");
        return `${parsed.host}${parsed.pathname}`;
      } catch {
        return value.split(/[?#]/u)[0];
      }
    };
    for (const element of imageNodes) {
      if (element.closest(excluded)) continue;
      const slide = element.closest(
        "[data-swiper-slide-index],[data-index],[class*='swiper-slide'],[class*='carousel-item'],[class*='slide-item']",
      );
      const values = [
        element.getAttribute("src"),
        element.getAttribute("data-src"),
        element.getAttribute("data-original"),
        element.getAttribute("data-lazy-src"),
        element.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0],
        element instanceof HTMLImageElement ? element.currentSrc : null,
      ].filter(Boolean) as string[];
      const background = getComputedStyle(element).backgroundImage;
      const backgroundMatch = background.match(/url\((['"]?)(.*?)\1\)/);
      if (backgroundMatch?.[2]) values.push(backgroundMatch[2]);
      const mediaValue = values.find((value) => stableMediaKey(value));
      if (!mediaValue) continue;
      const picture = element.closest("picture");
      const groupKey = slide
        ? `slide:${
            slide.getAttribute("data-swiper-slide-index") ||
            slide.getAttribute("data-index") ||
            elementPath(slide)
          }`
        : picture
          ? `picture:${elementPath(picture)}`
          : `media:${stableMediaKey(mediaValue)}`;
      imageCandidates.push({
        source: "DOM_MEDIA",
        groupKey,
        url: absoluteUrl(mediaValue),
        domPath: elementPath(element),
      });
    }

    const jsonPayloads: unknown[] = [];
    for (const script of [...document.scripts]) {
      const value = (script.textContent || "").trim();
      if (!value || value.length > 4_000_000) continue;
      if (script.type === "application/ld+json" || value.startsWith("{")) {
        try {
          jsonPayloads.push(JSON.parse(value));
        } catch {
          // Ignore non-JSON scripts.
        }
      } else if (/__INITIAL_STATE__|__NEXT_DATA__/u.test(value)) {
        const start = value.indexOf("{");
        const end = value.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try {
            jsonPayloads.push(
              JSON.parse(value.slice(start, end + 1).replace(/\bundefined\b/g, "null")),
            );
          } catch {
            // Ignore scripts that are not safely parseable JSON.
          }
        }
      }
    }

    const loginEvidence: string[] = [];
    if (/登录后推荐|请先登录|登录以继续|手机号登录|扫码登录/u.test(text)) {
      loginEvidence.push("页面显示登录提示");
    }
    if (/安全限制|IP存在风险|安全验证|访问验证|完成验证/u.test(text)) {
      loginEvidence.push("页面显示安全限制或验证提示");
    }

    let pageStatus: PageStatus = "NORMAL";
    if (loginEvidence.some((item) => item.includes("登录"))) {
      pageStatus = "LOGIN_EXPIRED";
    } else if (loginEvidence.some((item) => item.includes("安全"))) {
      pageStatus = "SECURITY_VERIFICATION";
    } else if (/笔记已删除|内容已删除|作者已删除/u.test(text)) {
      pageStatus = "NOTE_NOT_FOUND";
    } else if (/内容不存在|笔记不存在|页面不存在/u.test(text)) {
      pageStatus = "NOTE_NOT_FOUND";
    } else if (/暂无权限|无权查看|仅作者可见/u.test(text)) {
      pageStatus = "NO_PERMISSION";
    }

    return {
      finalUrl: location.href,
      pageTitle: document.title,
      visibleTextPreview: text.slice(0, 1_000),
      visibleTextLength: text.length,
      htmlLength: html.length,
      pageStatus,
      titleCandidates,
      bodyCandidates,
      textHashtagCandidates,
      verifiedPlatformTopics,
      imageCandidates,
      hasVideo,
      videoEvidence,
      videoCandidateCount: videoElements.length,
      hasLivePhotoMarker,
      hasCarouselStructure,
      carouselPageIndicator,
      carouselCurrent,
      carouselTotal,
      loginEvidence,
      jsonPayloads,
      publishedAtTextCandidates,
      keyElementCount: uniqueElements([
        "#detail-title",
        "#detail-desc",
        "[data-testid='note-content']",
        "[class*='note-detail']",
        "[class*='note-content']",
        "[class*='swiper']",
        "a[href*='/search_result']",
      ]).length,
      domSummary: uniqueElements([
        "main",
        "article",
        "[role='main']",
        "#noteContainer",
        "[class*='note-detail']",
        "[class*='note-content']",
        "[class*='swiper']",
      ])
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          className: String(element.className || "").slice(0, 200) || null,
        })),
    };
  });

  const jsonCandidates = snapshot.jsonPayloads
    .slice(0, 20)
    .map((item) => collectJsonCandidates(item, "PAGE_JSON"));
  const urlCandidates = createEmptyCandidates();
  urlCandidates.noteIdCandidates = noteIdCandidatesFromUrls([
    snapshot.finalUrl,
  ]);
  const currentNoteId = urlCandidates.noteIdCandidates[0]?.value || null;
  const domPublishedAtCandidates = snapshot.publishedAtTextCandidates
    .map((candidate) =>
      parseXhsPublishedAtText(candidate.raw, candidate.source, currentNoteId),
    )
    .filter((candidate): candidate is PlatformPublishedAtEvidence => Boolean(candidate));
  const merged = mergeCandidates(
    urlCandidates,
    {
      noteIdCandidates: [],
      titleCandidates: snapshot.titleCandidates,
      bodyCandidates: snapshot.bodyCandidates,
      textHashtagCandidates: snapshot.textHashtagCandidates,
      verifiedPlatformTopics: snapshot.verifiedPlatformTopics,
      imageCandidates: snapshot.imageCandidates,
      publishedAtCandidates: domPublishedAtCandidates,
      hasVideo: snapshot.hasVideo,
      loginEvidence: snapshot.loginEvidence,
      responseSummaries: [],
    },
    ...jsonCandidates,
  );
  const unavailablePage = detectUnavailableXhsPage({
    url: snapshot.finalUrl,
    title: snapshot.pageTitle,
    visibleText: snapshot.visibleTextPreview,
  });

  return {
    ...merged,
    finalUrl: snapshot.finalUrl,
    pageTitle: snapshot.pageTitle,
    visibleTextPreview: snapshot.visibleTextPreview,
    visibleTextLength: snapshot.visibleTextLength,
    htmlLength: snapshot.htmlLength,
    pageStatus: unavailablePage?.status || snapshot.pageStatus,
    keyElementCount: snapshot.keyElementCount,
    domSummary: snapshot.domSummary,
    domHasVideo: snapshot.hasVideo,
    videoEvidence: snapshot.videoEvidence,
    videoCandidateCount: snapshot.videoCandidateCount,
    hasLivePhotoMarker: snapshot.hasLivePhotoMarker,
    hasCarouselStructure: snapshot.hasCarouselStructure,
    carouselPageIndicator: snapshot.carouselPageIndicator,
    carouselCurrent: snapshot.carouselCurrent,
    carouselTotal: snapshot.carouselTotal,
  };
}

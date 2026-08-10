import type { ExtractedNote } from "@/lib/types";
import { redirect } from "next/navigation";
/* eslint-disable @next/next/no-img-element -- local mock must expose native image DOM to the extractor */

type MockCase = "video" | "image-text" | "business-pass" | "public-logged-out" | "topics" | "unclickable" | "not-found" | "logged-out" | "security" | "no-permission" | "app-launch" | "empty" | "multi-image" | "network-error" | "load-timeout";

function noteFor(caseName: MockCase): ExtractedNote {
  const base: ExtractedNote = {
    url: "", noteId: `douyin-${caseName}`, title: "抖音模拟作品", body: "这是用于验证抖音多平台采集底座的模拟作品正文。", noteType: "VIDEO", imageExtractionStatus: "VIDEO_NOTE", imageCount: 0,
    topics: [{ displayText: "#抖音模拟话题", isLinkElement: true, hasHref: true, href: "/search/%E6%8A%96%E9%9F%B3%E6%A8%A1%E6%8B%9F%E8%AF%9D%E9%A2%98", styleFeature: true, source: "DOM" }],
    pageStatus: "NORMAL", authorName: "抖音模拟作者", publishedAt: "2026-08-07T08:00:00.000Z", publishedAtRaw: "2026-08-07 16:00:00", publishedAtSource: "DOUYIN_STRUCTURED:create_time", isPublic: true, extractedAt: new Date().toISOString(), adapterName: "playwright-douyin", adapterVersion: "1.0.0",
  };
  if (caseName === "topics") {
    return {
      ...base,
      topics: [
        ...base.topics,
        {
          displayText: "#抖音第二话题",
          isLinkElement: true,
          hasHref: true,
          href: "/search/%E6%8A%96%E9%9F%B3%E7%AC%AC%E4%BA%8C%E8%AF%9D%E9%A2%98",
          styleFeature: true,
          source: "DOM",
        },
      ],
    };
  }
  if (caseName === "business-pass") {
    return {
      ...base,
      body: `${"抖音图文正文".repeat(10)}抖音图文正`,
      noteType: "IMAGE_TEXT",
      imageExtractionStatus: "SUCCESS",
      imageCount: 3,
      isPublic: null,
      topics: [
        "#爱他美澳洲白金版",
        "#FOLO海外旗舰店",
        "#二段奶粉推荐",
      ].map((displayText) => ({
        displayText,
        isClickable: true,
        isLinkElement: true,
        hasHref: true,
        href: `/search/${encodeURIComponent(displayText.slice(1))}`,
        styleFeature: true,
        source: "STRUCTURED_RESPONSE",
      })),
    };
  }
  if (caseName === "image-text" || caseName === "multi-image") return { ...base, noteType: "IMAGE_TEXT", imageExtractionStatus: "SUCCESS", imageCount: caseName === "multi-image" ? 5 : 3 };
  if (caseName === "unclickable") return { ...base, topics: base.topics.map((topic) => ({ ...topic, isLinkElement: false, hasHref: false, href: null })) };
  if (caseName === "empty") return { ...base, body: "", topics: [], technicalWarnings: ["BODY_NOT_RECOGNIZED", "TOPICS_NOT_RECOGNIZED"] };
  const statuses: Partial<Record<MockCase, ExtractedNote["pageStatus"]>> = { "not-found": "NOTE_NOT_FOUND", "logged-out": "LOGIN_EXPIRED", security: "SECURITY_VERIFICATION", "no-permission": "NO_PERMISSION" };
  const status = statuses[caseName];
  return status ? { ...base, pageStatus: status as ExtractedNote["pageStatus"] } : base;
}

export default async function MockDouyinPage({ searchParams }: { searchParams: Promise<{ case?: string; topic?: string; clickable?: string; raw?: string; publishedText?: string; recommendedTime?: string }> }) {
  const params = await searchParams;
  const requested = params.case || "video";
  if (requested === "short-link") {
    redirect("/mock/douyin?case=video&redirectedFrom=short-link");
  }
  const allowed: MockCase[] = ["video", "image-text", "business-pass", "public-logged-out", "topics", "unclickable", "not-found", "logged-out", "security", "no-permission", "app-launch", "empty", "multi-image", "network-error", "load-timeout"];
  const caseName = (allowed.includes(requested as MockCase) ? requested : "video") as MockCase;
  const rawExtraction = params.raw === "true";
  const baseNote = noteFor(caseName);
  const injectedTopic = String(params.topic || "").trim();
  const injectedTopicClickable = params.clickable !== "false";
  const note = injectedTopic && baseNote.pageStatus === "NORMAL"
    ? {
        ...baseNote,
        topics: [
          ...baseNote.topics,
          {
            displayText: injectedTopic.startsWith("#")
              ? injectedTopic
              : `#${injectedTopic}`,
            isLinkElement: injectedTopicClickable,
            hasHref: injectedTopicClickable,
            href: injectedTopicClickable
              ? `/search/${encodeURIComponent(injectedTopic.replace(/^#/u, ""))}`
              : null,
            styleFeature: injectedTopicClickable,
            source: "DOM",
          },
        ],
      }
    : baseNote;
  const statusText: Record<MockCase, string | undefined> = { video: undefined, "image-text": undefined, "business-pass": undefined, "public-logged-out": undefined, topics: undefined, unclickable: undefined, empty: undefined, "multi-image": undefined, "not-found": "作品不存在，该作品已删除", "logged-out": "登录后继续，请扫码登录", security: "访问频繁，需要安全验证", "no-permission": "私密作品，暂无权限查看", "app-launch": "打开抖音 App 查看", "network-error": "模拟临时网络连接中断", "load-timeout": "模拟页面加载超时" };
  return (
    <main data-douyin-page-status={caseName} style={{ padding: 48 }}>
      <article data-e2e="note-detail">
        <h1>{note.title}</h1>
        {statusText[caseName] ? <p>{statusText[caseName]}</p> : <>
          <div data-testid="douyin-author">{note.authorName}</div>
          {rawExtraction && caseName === "business-pass" ? (
            <div className="unstable-caption-container">
              <span>
                {note.body}
                {note.topics.map((topic) => (
                  <a data-douyin-topic href={topic.href || "#"} key={topic.displayText}>
                    {topic.displayText}
                  </a>
                ))}
              </span>
              <button type="button">展开</button>
            </div>
          ) : <p data-e2e="video-desc" data-testid="douyin-description">{note.body}</p>}
          {note.noteType === "VIDEO" ? <video aria-label="抖音模拟视频" /> : Array.from({ length: note.imageCount || 0 }, (_, index) => <img data-testid="douyin-image" src={`/mock-media/douyin/${index + 1}.jpg`} alt={`模拟图片${index + 1}`} key={index} />)}
          {rawExtraction && caseName === "business-pass" ? null : <div>{note.topics.map((topic) => topic.isLinkElement ? <a data-douyin-topic href={topic.href || "#"} key={topic.displayText}>{topic.displayText}</a> : <span key={topic.displayText}>{topic.displayText}</span>)}</div>}
          {rawExtraction ? (
            <div data-e2e="video-publish-time">
              发布时间：{params.publishedText || "2026-08-04 14:40:13"}
            </div>
          ) : null}
        </>}
      </article>
      {caseName === "public-logged-out" ? (
        <aside data-testid="douyin-comment-login">
          登录后查看更多评论，请扫码登录
        </aside>
      ) : null}
      {rawExtraction && params.recommendedTime ? (
        <aside data-e2e="recommend-list">
          <span>发布时间：{params.recommendedTime}</span>
        </aside>
      ) : null}
      {rawExtraction ? null : <script id="mock-douyin-extraction-data" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify(note).replace(/</gu, "\\u003c") }} />}
    </main>
  );
}

import { createMockNote, mockCaseLabels, type MockCase } from "@/lib/mock-data";

export default async function MockXhsPage({
  searchParams,
}: {
  searchParams: Promise<{ case?: string }>;
}) {
  const requested = (await searchParams).case || "passed";
  const caseName = (
    Object.hasOwn(mockCaseLabels, requested) ? requested : "passed"
  ) as MockCase;
  const note = createMockNote(caseName);
  const extractionNote = { ...note };
  delete extractionNote.imageUrls;

  if (note.pageStatus !== "NORMAL") {
    const statusMessages: Record<string, { title: string; detail: string }> = {
      READ_FAILED: {
        title: "页面暂时无法读取",
        detail: "这是用于验证单条读取失败不阻断队列的模拟页面。",
      },
      NOT_FOUND: { title: "页面不存在", detail: "该笔记链接不存在。" },
      DELETED: { title: "笔记已删除", detail: "该笔记已被作者删除。" },
      NO_PERMISSION: { title: "无权限访问", detail: "当前账号无权查看该笔记。" },
      LOGIN_EXPIRED: { title: "登录已失效", detail: "请重新登录后继续审核。" },
      SECURITY_VERIFICATION: {
        title: "需要安全验证",
        detail: "请在专用浏览器中手动完成验证。",
      },
    };
    const message = statusMessages[note.pageStatus] || statusMessages.READ_FAILED;
    return (
      <main className="mock-page" data-xhs-page-status={note.pageStatus}>
        <div className="mock-body" style={{ paddingTop: 120, textAlign: "center" }}>
          <h1>{message.title}</h1>
          <p className="muted">{message.detail}</p>
        </div>
        <script
          id="mock-extraction-data"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(extractionNote).replace(/</g, "\\u003c") }}
        />
      </main>
    );
  }

  return (
    <main
      className="mock-page"
      data-xhs-page-status="NORMAL"
      data-xhs-note-id={note.noteId || ""}
      data-xhs-author={note.authorName || ""}
      data-xhs-published-at={note.publishedAt || ""}
      data-xhs-public={String(note.isPublic === true)}
    >
      <div className="mock-hero">模拟笔记正文与话题审核</div>
      <article className="mock-body">
        {note.noteType === "VIDEO_NOTE" ? (
          <div data-testid="note-media" className="video-player">
            <video aria-label="模拟视频笔记" controls={false} />
          </div>
        ) : note.imageExtractionStatus === "SUCCESS" ? (
          <div data-testid="note-media" className="swiper-container">
            {Array.from({ length: note.imageCount ?? 0 }, (_, index) => (
              <div
                className="swiper-slide"
                data-swiper-slide-index={index}
                key={index}
              >
                <picture>
                  <source
                    srcSet={`/mock-media/${caseName}/${index + 1}.webp 1x`}
                  />
                  <img
                    src={`/mock-media/${caseName}/${index + 1}.jpg`}
                    alt={`模拟笔记图片 ${index + 1}`}
                  />
                </picture>
              </div>
            ))}
          </div>
        ) : null}
        <div className="muted" style={{ marginBottom: 14 }}>
          模拟案例 · {mockCaseLabels[caseName]} · {note.authorName}
        </div>
        <h1 data-xhs-title style={{ fontSize: 26 }}>{note.title}</h1>
        <p data-xhs-body style={{ lineHeight: 1.9, whiteSpace: "pre-wrap" }}>
          {note.body}
        </p>
        <div data-xhs-topics style={{ margin: "22px 0" }}>
          {note.topics.map((topic) =>
            topic.isLinkElement ? (
              <a
                key={topic.displayText}
                href={topic.href || undefined}
                className="mock-topic topic"
                data-topic={topic.displayText.replace(/^#/, "")}
                data-xhs-topic
              >
                {topic.displayText}
              </a>
            ) : (
              <span
                key={topic.displayText}
                className="mock-topic fake-topic"
                data-xhs-topic
              >
                {topic.displayText}
              </span>
            ),
          )}
        </div>
      </article>
      <script
        id="mock-extraction-data"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(extractionNote).replace(/</g, "\\u003c") }}
      />
    </main>
  );
}

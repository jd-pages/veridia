const payload = {
  url: "",
  noteId: "douyin-stream-timeout",
  title: "抖音导航超时后已渲染作品",
  body: "页面主内容已经出现，持续连接不应导致页面打开失败。",
  noteType: "IMAGE_TEXT",
  imageExtractionStatus: "SUCCESS",
  imageCount: 2,
  topics: [
    {
      displayText: "#抖音导航测试",
      isLinkElement: true,
      hasHref: true,
      href: "/search/抖音导航测试",
      styleFeature: true,
      source: "DOM",
    },
  ],
  pageStatus: "NORMAL",
  authorName: "抖音导航测试作者",
  publishedAt: "2026-08-10T08:00:00.000Z",
  publishedAtRaw: "2026-08-10 16:00:00",
  publishedAtSource: "DOUYIN_DOM_CURRENT_DETAIL:publish-time",
  isPublic: null,
  extractedAt: "2026-08-10T08:00:00.000Z",
  adapterName: "playwright-douyin",
  adapterVersion: "1.2.0",
};

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>抖音导航超时后已渲染作品</title></head>
<body><main><article data-e2e="note-detail"><h1>${payload.title}</h1>
<p data-e2e="video-desc">${payload.body}</p><img data-testid="douyin-image" src="/mock-media/douyin/1.jpg" alt="模拟图片1">
<img data-testid="douyin-image" src="/mock-media/douyin/2.jpg" alt="模拟图片2">
<a data-douyin-topic href="/search/抖音导航测试">#抖音导航测试</a></article>
<script id="mock-douyin-extraction-data" type="application/json">${JSON.stringify(payload).replace(/</gu, "\\u003c")}</script></main>`));
      setTimeout(() => {
        controller.enqueue(encoder.encode("</body></html>"));
        controller.close();
      }, 2_000);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

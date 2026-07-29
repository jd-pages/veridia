(function registerMock(global) {
  const namespace = global.XhsAdapters;

  namespace.MockExtractorAdapter = class MockExtractorAdapter extends namespace.BaseExtractorAdapter {
    constructor() {
      super("mock-xhs", "1.2.0");
    }

    canHandle() {
      return /localhost|127\.0\.0\.1/.test(location.hostname) && location.pathname === "/mock/xhs";
    }

    extract() {
      const embedded = document.querySelector("#mock-extraction-data");
      if (embedded?.textContent) {
        try {
          const parsed = JSON.parse(embedded.textContent);
          delete parsed.imageUrls;
          return {
            ...parsed,
            url: location.href,
            extractedAt: new Date().toISOString(),
            adapterName: this.name,
            adapterVersion: this.version,
          };
        } catch {
          // 继续使用 DOM 回退提取。
        }
      }
      const topics = [...document.querySelectorAll("[data-xhs-topic]")].map((element) =>
        this.toTopic(element),
      );
      return this.result({
        noteId: document.querySelector("[data-xhs-note-id]")?.dataset.xhsNoteId || null,
        title: this.text("[data-xhs-title]"),
        body: this.text("[data-xhs-body]"),
        noteType: "UNKNOWN",
        imageExtractionStatus: "IMAGES_READ_FAILED",
        topics,
        authorName: document.querySelector("[data-xhs-author]")?.dataset.xhsAuthor || null,
        publishedAt:
          document.querySelector("[data-xhs-published-at]")?.dataset.xhsPublishedAt || null,
        isPublic:
          document.querySelector("[data-xhs-public]")?.dataset.xhsPublic === "true",
      });
    }
  };
})(globalThis);

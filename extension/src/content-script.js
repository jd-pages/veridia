(function contentBridge(global) {
  const adapters = [
    new global.XhsAdapters.MockExtractorAdapter(),
    new global.XhsAdapters.XiaohongshuExtractorAdapter(),
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "EXTRACT_CURRENT_NOTE") return undefined;
    try {
      const adapter = adapters.find((candidate) => candidate.canHandle());
      if (!adapter) throw new Error("当前页面不是支持的小红书笔记或本地模拟页面");
      sendResponse({ success: true, data: adapter.extract() });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "页面提取失败",
      });
    }
    return true;
  });
})(globalThis);

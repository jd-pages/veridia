const DEFAULT_API_BASE_URL = "http://localhost:3100";
const LEGACY_API_BASE_URL = "http://localhost:3000";
const DEFAULT_EXTENSION_TOKEN = "local-extension-demo-token";

const apiBaseUrl = document.querySelector("#apiBaseUrl");
const extensionToken = document.querySelector("#extensionToken");
const taskId = document.querySelector("#taskId");
const extractButton = document.querySelector("#extract");
const testConnectionButton = document.querySelector("#testConnection");
const status = document.querySelector("#status");

chrome.storage.local.get(
  {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    extensionToken: DEFAULT_EXTENSION_TOKEN,
  },
  (settings) => {
    const savedUrl =
      settings.apiBaseUrl === LEGACY_API_BASE_URL
        ? DEFAULT_API_BASE_URL
        : settings.apiBaseUrl;
    apiBaseUrl.value = savedUrl;
    extensionToken.value = settings.extensionToken;
    if (savedUrl !== settings.apiBaseUrl) {
      chrome.storage.local.set({ apiBaseUrl: savedUrl });
    }
  },
);

function setStatus(text, type) {
  status.textContent = text;
  status.className = `status ${type || "muted"}`;
}

function setBusy(busy) {
  extractButton.disabled = busy;
  testConnectionButton.disabled = busy;
}

async function saveSettings() {
  const normalizedUrl = apiBaseUrl.value.trim().replace(/\/+$/, "");
  apiBaseUrl.value = normalizedUrl;
  await chrome.storage.local.set({
    apiBaseUrl: normalizedUrl,
    extensionToken: extensionToken.value,
  });
}

testConnectionButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("正在测试本地系统连接…", "muted");
  try {
    await saveSettings();
    const result = await chrome.runtime.sendMessage({
      type: "TEST_EXTENSION_CONNECTION",
    });
    if (!result?.success) throw new Error(result?.error || "连接测试失败");
    setStatus("连接成功，接口与提交令牌均有效。", "success");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "连接测试失败",
      "error",
    );
  } finally {
    setBusy(false);
  }
});

extractButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("正在读取当前可见页面…", "muted");
  try {
    await saveSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("页面提取失败：没有找到当前标签页");

    let extracted;
    try {
      extracted = await chrome.tabs.sendMessage(tab.id, {
        type: "EXTRACT_CURRENT_NOTE",
      });
    } catch {
      throw new Error(
        "页面提取失败：当前页面未加载提取脚本，请刷新小红书页面后重试",
      );
    }
    if (!extracted?.success) {
      throw new Error(
        `页面提取失败：${extracted?.error || "无法读取当前页面"}`,
      );
    }

    setStatus(
      `已提取正文和 ${extracted.data.topics.length} 个话题，正在提交…`,
      "muted",
    );
    const submitted = await chrome.runtime.sendMessage({
      type: "SUBMIT_AUDIT_EXTRACTION",
      taskId: taskId.value.trim(),
      extraction: extracted.data,
    });
    if (!submitted?.success) {
      throw new Error(submitted?.error || "提交失败");
    }
    setStatus(
      `审核完成：${submitted.data.autoStatus}。${submitted.data.failureReasons.join("；") || "固定规则全部通过"}`,
      "success",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "处理失败", "error");
  } finally {
    setBusy(false);
  }
});

const DEFAULT_API_BASE_URL = "http://localhost:3100";
const LEGACY_API_BASE_URL = "http://localhost:3000";
const DEFAULT_EXTENSION_TOKEN = "local-extension-demo-token";

function readSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        apiBaseUrl: DEFAULT_API_BASE_URL,
        extensionToken: DEFAULT_EXTENSION_TOKEN,
      },
      resolve,
    );
  });
}

function saveSettings(settings) {
  return new Promise((resolve) => chrome.storage.local.set(settings, resolve));
}

function normalizeBaseUrl(value) {
  const normalized = String(value || DEFAULT_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("本地系统地址必须使用 http 或 https");
  }
  return parsed.origin;
}

async function getSettings() {
  const settings = await readSettings();
  let apiBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
  if (apiBaseUrl === LEGACY_API_BASE_URL) {
    apiBaseUrl = DEFAULT_API_BASE_URL;
    await saveSettings({ apiBaseUrl });
  }
  return {
    apiBaseUrl,
    extensionToken: String(settings.extensionToken || ""),
  };
}

function containsOriginPermission(origin) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [`${origin}/*`] }, resolve);
  });
}

async function diagnoseNetworkFailure(apiBaseUrl) {
  if (!(await containsOriginPermission(apiBaseUrl))) {
    return {
      code: "CORS_BLOCKED",
      error: "CORS 拦截或插件缺少该地址权限，请重新加载插件",
    };
  }

  try {
    await fetch(`${apiBaseUrl}/api/extension/health`, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
    });
    return {
      code: "CORS_BLOCKED",
      error: "CORS 拦截了本地接口响应，请重新加载插件后重试",
    };
  } catch {
    return {
      code: "SERVICE_UNAVAILABLE",
      error: "本地审核服务未启动或地址不可达",
    };
  }
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseFailure(response, payload) {
  if (response.status === 401) {
    return { code: "INVALID_TOKEN", error: "插件提交令牌错误" };
  }
  if (response.status === 404 && payload?.code === "TASK_NOT_FOUND") {
    return { code: "TASK_NOT_FOUND", error: payload.error };
  }
  if (response.status === 404 || response.status === 405) {
    return {
      code: "ENDPOINT_NOT_FOUND",
      error: "本地审核接口不存在，请确认插件与系统版本一致",
    };
  }
  return {
    code: payload?.code || "REQUEST_FAILED",
    error: payload?.error || `本地接口请求失败（HTTP ${response.status}）`,
  };
}

async function requestLocalApi(path, { method = "GET", body } = {}) {
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      error: "本地系统地址格式不正确",
    };
  }

  const endpoint = `${settings.apiBaseUrl}${path}`;
  try {
    const response = await fetch(endpoint, {
      method,
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-Extension-Token": settings.extensionToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await readPayload(response);
    if (!response.ok || !payload?.success) {
      const failure = responseFailure(response, payload);
      console.error("[笔记合规插件] 本地接口请求失败", {
        endpoint,
        status: response.status,
        code: failure.code,
      });
      return { success: false, status: response.status, ...failure };
    }
    return { success: true, data: payload.data };
  } catch {
    const failure = await diagnoseNetworkFailure(settings.apiBaseUrl);
    console.error("[笔记合规插件] 本地接口连接失败", {
      endpoint,
      code: failure.code,
    });
    return { success: false, ...failure };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TEST_EXTENSION_CONNECTION") {
    requestLocalApi("/api/extension/health").then(sendResponse);
    return true;
  }

  if (message?.type === "SUBMIT_AUDIT_EXTRACTION") {
    requestLocalApi("/api/extension/submit", {
      method: "POST",
      body: {
        taskId: message.taskId || undefined,
        extraction: message.extraction,
      },
    }).then(sendResponse);
    return true;
  }

  return undefined;
});

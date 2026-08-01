export interface ApiEnvelope<T> {
  success: boolean;
  ok?: boolean;
  data: T;
  error?: string | { code?: string; message?: string };
  errorDetail?: { code?: string; message?: string };
}

function responseErrorMessage<T>(payload: ApiEnvelope<T>, status: number) {
  const serverMessage =
    typeof payload.error === "string"
      ? payload.error
      : payload.error?.message || payload.errorDetail?.message;
  if (serverMessage) return serverMessage;
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "当前账号无此操作权限，请联系管理员。";
  return "数据读取失败，请刷新或重启 VERIDIA。";
}

export async function safeFetchJson<T>(response: Response) {
  const rawBody = await response.text();
  if (!rawBody.trim()) {
    throw new Error(
      response.status === 403
        ? "当前账号无此操作权限，请联系管理员。"
        : "数据读取失败，请刷新或重启 VERIDIA。",
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) {
    throw new Error("数据读取失败，请刷新或重启 VERIDIA。");
  }
  try {
    return JSON.parse(rawBody) as ApiEnvelope<T>;
  } catch {
    throw new Error("数据读取失败，请刷新或重启 VERIDIA。");
  }
}

export async function apiFetch<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  const payload = await safeFetchJson<T>(response);
  if (!response.ok || !payload.success) {
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/login"
    ) {
      void window.veridiaDesktop?.clearPersistentSession().catch(() => false);
      window.location.assign("/login");
    }
    throw new Error(responseErrorMessage(payload, response.status));
  }
  return payload.data;
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

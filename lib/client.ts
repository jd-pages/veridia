export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
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
  const rawBody = await response.text();
  if (!rawBody.trim()) {
    throw new Error(`服务返回了空响应（HTTP ${response.status}）`);
  }
  let payload: ApiEnvelope<T>;
  try {
    payload = JSON.parse(rawBody) as ApiEnvelope<T>;
  } catch {
    const contentType = response.headers.get("content-type") || "未知类型";
    throw new Error(
      `服务返回了无法识别的响应（HTTP ${response.status}，${contentType}）`,
    );
  }
  if (!response.ok || !payload.success) {
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/login"
    ) {
      void window.veridiaDesktop?.clearPersistentSession().catch(() => false);
      window.location.assign("/login");
    }
    throw new Error(payload.error || "请求失败");
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

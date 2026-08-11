function responseStatus(response) {
  if (!response) return null;
  return typeof response.status === "function"
    ? response.status()
    : response.status;
}

function responseOk(response) {
  if (!response) return false;
  return typeof response.ok === "function"
    ? response.ok()
    : response.ok;
}

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForStartupRoute(input) {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const intervalMs = input.intervalMs ?? 200;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const startedAt = now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const response = await input.request();
    const status = responseStatus(response);
    if (responseOk(response)) {
      return { response, attempts, elapsedMs: now() - startedAt };
    }
    if (status !== 404) {
      throw new Error(
        `${input.label} 未就绪: HTTP ${status ?? "无响应"}（非启动期 404，不重试）`,
      );
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `${input.label} 启动就绪超时: HTTP 404，已尝试 ${attempts} 次`,
      );
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}

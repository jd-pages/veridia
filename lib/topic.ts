export function normalizeTopic(input: string): string {
  const trimmed = input.trim().replace(/^#+/, "").trim();
  return trimmed ? `#${trimmed}` : "";
}

export function compareTopic(
  actual: string,
  expected: string,
  caseSensitive = false,
): boolean {
  const normalizedActual = normalizeTopic(actual);
  const normalizedExpected = normalizeTopic(expected);
  return caseSensitive
    ? normalizedActual === normalizedExpected
    : normalizedActual.toLocaleLowerCase("zh-CN") ===
        normalizedExpected.toLocaleLowerCase("zh-CN");
}

export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (["share_from_user_hidden", "xhsshare", "appuid", "apptime"].includes(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString().replace(/\/$/, "");
}

export function isSupportedNoteUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname.endsWith("xiaohongshu.com") ||
        url.hostname === "xhslink.com")
    );
  } catch {
    return false;
  }
}

export function normalizeTopic(input: string): string {
  const normalized = String(input || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/gu, "")
    .trim()
    .replace(/^[#＃]+\s*/u, "")
    .replace(/\s+/gu, "");
  return normalized ? `#${normalized}` : "";
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
  if (process.env.NODE_ENV !== "production") {
    try {
      const url = new URL(input.trim());
      if (["localhost", "127.0.0.1"].includes(url.hostname)) return true;
    } catch {
      return false;
    }
  }
  return isSupportedXiaohongshuNoteUrl(input);
}

export function extractSupportedNoteUrls(input: string | string[]): string[] {
  const extracted = extractNoteLinksFromText(input).links.map((item) => item.url);
  if (process.env.NODE_ENV === "production") return extracted;
  const values = Array.isArray(input) ? input : [input];
  const localUrls = values
    .flatMap((value) => value.match(/https?:\/\/[^\s<>"']+/giu) || [])
    .map((value) => value.replace(/[，。；;）)】\]]+$/u, ""))
    .filter((value) => {
      try {
        return ["localhost", "127.0.0.1"].includes(new URL(value).hostname);
      } catch {
        return false;
      }
    });
  return [...new Set([...extracted, ...localUrls])];
}

export { extractNoteLinksFromText } from "./note-links";
import {
  extractNoteLinksFromText,
  isSupportedXiaohongshuNoteUrl,
} from "./note-links";

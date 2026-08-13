const DOUYIN_TOPIC_NOISE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/gu;

/**
 * Normalize a Douyin topic entity without changing legitimate characters
 * inside its name. Douyin caption DOM can expose adjacent topic separators as
 * part of an interactive node's textContent, for example `#topic#`.
 */
export function normalizeDouyinTopicName(value: unknown): string {
  const topicName = String(value ?? "")
    .normalize("NFKC")
    .replace(DOUYIN_TOPIC_NOISE, "")
    .trim()
    .replace(/^[#\s]+/gu, "")
    .replace(/[#\s]+$/gu, "");
  return topicName ? `#${topicName}` : "";
}

export function douyinTopicMatchKey(
  value: unknown,
  caseSensitive = false,
): string {
  const normalized = normalizeDouyinTopicName(value);
  return caseSensitive
    ? normalized
    : normalized.toLocaleLowerCase("zh-CN");
}

export function compareDouyinTopicNames(
  actual: unknown,
  expected: unknown,
  caseSensitive = false,
): boolean {
  return (
    douyinTopicMatchKey(actual, caseSensitive) ===
    douyinTopicMatchKey(expected, caseSensitive)
  );
}

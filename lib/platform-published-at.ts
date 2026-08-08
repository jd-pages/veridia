export interface PlatformPublishedAtEvidence {
  value: string | null;
  raw: string;
  source: string;
  contentId: string | null;
}

interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function shanghaiParts(value: Date): ShanghaiParts {
  const parts = Object.fromEntries(
    shanghaiFormatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function shanghaiInstant(parts: ShanghaiParts) {
  const value = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour - 8,
      parts.minute,
      parts.second,
    ),
  );
  const verified = shanghaiParts(value);
  return verified.year === parts.year &&
      verified.month === parts.month &&
      verified.day === parts.day &&
      verified.hour === parts.hour &&
      verified.minute === parts.minute &&
      verified.second === parts.second
    ? value
    : null;
}

function evidence(
  value: Date | null,
  raw: string,
  source: string,
  contentId: string | null,
): PlatformPublishedAtEvidence | null {
  if (!raw || (value && Number.isNaN(value.getTime()))) return null;
  return {
    value: value?.toISOString() ?? null,
    raw,
    source,
    contentId,
  };
}

function parseShanghaiDisplayTime(raw: string) {
  const match = raw.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u,
  );
  if (!match) return null;
  return shanghaiInstant({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 12),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
  });
}

export function parseStructuredPublishedAt(
  input: unknown,
  source: string,
  contentId: string | null,
): PlatformPublishedAtEvidence | null {
  if (input === null || input === undefined || input === "") return null;
  const inputText = String(input).trim();
  if (!inputText) return null;

  if (/^\d{9,16}$/u.test(inputText)) {
    const numeric = Number(inputText);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const value = new Date(milliseconds);
    return evidence(value, formatShanghaiDateTime(value), source, contentId);
  }

  const localDisplay = inputText.replace(/^发布时间[：:]\s*/u, "");
  const shanghaiValue = parseShanghaiDisplayTime(localDisplay);
  if (shanghaiValue) {
    return evidence(shanghaiValue, localDisplay, source, contentId);
  }

  const parsed = new Date(inputText);
  if (Number.isNaN(parsed.getTime())) return null;
  return evidence(parsed, formatShanghaiDateTime(parsed), source, contentId);
}

export function parseXhsPublishedAtText(
  input: unknown,
  source: string,
  contentId: string | null,
): PlatformPublishedAtEvidence | null {
  if (typeof input !== "string") return null;
  const text = input.replace(/\s+/gu, " ").trim();
  if (!text) return null;

  const match = text.match(
    /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|昨天\s*\d{1,2}:\d{2}(?::\d{2})?|\d{1,4}天前|\d{1,6}小时前|\d{1,6}分钟前)(?:\s|$)/u,
  );
  if (!match) return null;

  const raw = match[1].replace(/\s+/gu, " ").trim();
  // XHS may omit the year or use relative wording. Keep those platform
  // semantics verbatim instead of inventing a calendar date.
  const value = /^\d{4}[-/.]/u.test(raw)
    ? parseShanghaiDisplayTime(raw)
    : null;
  return evidence(value, raw, source, contentId);
}

export function formatShanghaiDateTime(input: unknown) {
  if (!input) return "—";
  const value = input instanceof Date ? input : new Date(String(input));
  if (Number.isNaN(value.getTime())) return "—";
  const parts = shanghaiParts(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function formatPlatformPublishedAt(
  input: unknown,
  raw: unknown,
) {
  const original = typeof raw === "string" ? raw.trim() : "";
  return original || formatShanghaiDateTime(input);
}

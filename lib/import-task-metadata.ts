export interface ImportedTaskMetadata {
  platform: string;
  shopName: string;
  customerName: string;
  orderNumber: string;
  contentChannel: string;
  publishTime: string;
}

const LABELS: Record<keyof ImportedTaskMetadata, string> = {
  platform: "平台：",
  shopName: "店铺名称：",
  customerName: "客户名：",
  orderNumber: "订单编号：",
  contentChannel: "内容渠道：",
  publishTime: "发帖时间：",
};

function singleLine(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n]+/gu, " ")
    .trim();
}

export function buildImportedTaskNotes(
  input: Partial<ImportedTaskMetadata> & { notes?: unknown },
) {
  const metadataLines = (Object.keys(LABELS) as Array<keyof ImportedTaskMetadata>)
    .map((field) => {
      const value = singleLine(input[field]);
      return value ? `${LABELS[field]}${value}` : "";
    })
    .filter(Boolean);
  const notes = String(input.notes ?? "").trim();
  return [...metadataLines, notes].filter(Boolean).join("\n");
}

export function importedTaskMetadataFromNotes(
  notes: unknown,
): ImportedTaskMetadata {
  const lines = String(notes ?? "").split(/\r?\n/gu);
  return Object.fromEntries(
    (Object.keys(LABELS) as Array<keyof ImportedTaskMetadata>).map((field) => {
      const prefix = LABELS[field];
      const line = lines.find((candidate) =>
        candidate.trim().startsWith(prefix),
      );
      return [field, line?.trim().slice(prefix.length).trim() || ""];
    }),
  ) as unknown as ImportedTaskMetadata;
}

export function importedPublishTimeValue(value: unknown): Date | string {
  const text = singleLine(value);
  if (!text) return "";
  const localMatch = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u,
  );
  const parsed = localMatch
    ? new Date(Date.UTC(
        Number(localMatch[1]),
        Number(localMatch[2]) - 1,
        Number(localMatch[3]),
        Number(localMatch[4] || 0),
        Number(localMatch[5] || 0),
        Number(localMatch[6] || 0),
      ))
    : new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed;
}

export interface ImportBatchLabelInput {
  id: string;
  fileName: string;
  createdAt: Date | string;
  validCount: number;
  skippedCount?: number;
  creatorDisplayName?: string | null;
}

export function formatImportBatchTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function buildImportBatchLabel(input: ImportBatchLabelInput) {
  const imported = `导入 ${input.validCount} 条`;
  const skipped = input.skippedCount
    ? ` / 跳过 ${input.skippedCount} 条`
    : "";
  return `${formatImportBatchTime(input.createdAt)} · ${input.fileName} · ${imported}${skipped}`;
}

export function buildImportBatchSearchText(input: ImportBatchLabelInput) {
  return [
    buildImportBatchLabel(input),
    input.id,
    input.creatorDisplayName || "",
  ]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

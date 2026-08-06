export function formatLocalExportTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("_");
}

function sanitizeWindowsFileSegment(value: string) {
  return value
    .replace(/\.(?:xlsx?|csv)$/iu, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 80) || "导入批次";
}

function formatCompactTimestamp(date: Date) {
  return formatLocalExportTimestamp(date).replace("_", "-");
}

export function auditResultExportFileName(input: {
  date?: Date;
  kabrita?: boolean;
  selected?: boolean;
  extension?: "xlsx" | "csv";
  importBatch?: { fileName: string; createdAt: Date | string } | null;
  danoneMixed?: boolean;
}) {
  if (input.importBatch && !input.selected) {
    const importedAt = new Date(input.importBatch.createdAt);
    const importedTimestamp = Number.isNaN(importedAt.getTime())
      ? "导入时间未知"
      : formatCompactTimestamp(importedAt);
    return `审核结果_${sanitizeWindowsFileSegment(input.importBatch.fileName)}_${importedTimestamp}_${formatCompactTimestamp(input.date || new Date())}.${input.extension || "xlsx"}`;
  }
  const scope = input.selected ? "所选结果" : "当前筛选";
  if (input.danoneMixed) {
    return `VERIDIA-审核结果-达能混合-${formatLocalExportTimestamp(input.date).replace("_", "-")}.${input.extension || "xlsx"}`;
  }
  const brand = input.kabrita ? "佳贝艾特" : "";
  return `VERIDIA${brand}审核结果_${scope}_${formatLocalExportTimestamp(input.date)}.${input.extension || "xlsx"}`;
}

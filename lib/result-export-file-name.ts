export function formatLocalExportTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("_");
}

export function auditResultExportFileName(input: {
  date?: Date;
  kabrita?: boolean;
  selected?: boolean;
  extension?: "xlsx" | "csv";
}) {
  const scope = input.selected ? "所选结果" : "当前筛选";
  const brand = input.kabrita ? "佳贝艾特" : "";
  return `VERIDIA${brand}审核结果_${scope}_${formatLocalExportTimestamp(input.date)}.${input.extension || "xlsx"}`;
}

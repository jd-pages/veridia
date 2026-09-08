import ExcelJS from "exceljs";

export const importHeaders = [
  "平台",
  "店铺名称（必填）",
  "客户名（必填）",
  "产品系列（必填）",
  "阶段（IFFO/GUM）",
  "段位",
  "订单编号",
  "内容渠道",
  "链接（必填）",
  "发布时间（必填）",
  "活动名称（必填）",
];

export interface ImportRowFixtureOptions {
  productName?: string;
  activityName?: string;
  contentChannel?: "小红书" | "抖音";
}

export function importDataRow(index: number, options: ImportRowFixtureOptions = {}) {
  const contentChannel = options.contentChannel || "小红书";
  return [
    "京东",
    "京东健康官方进口超市",
    index === 1 ? "中文🙂客户" : `客户${index}`,
    options.productName || "爱他美奇迹绿罐",
    "IFFO",
    "2段",
    index === 2 ? "" : String(index),
    contentChannel,
    contentChannel === "抖音"
      ? `https://www.douyin.com/video/${7_000_000_000_000_000_000n + BigInt(index)}`
      : `https://www.xiaohongshu.com/explore/${index.toString(16).padStart(24, "0")}`,
    "2026-09-08 12:34:56",
    options.activityName || "达能2026年8月小红书种草审核",
  ];
}

function rowsWithBlanks(
  dataRows: number,
  blankEvery = 0,
  options: ImportRowFixtureOptions = {},
) {
  const rows: string[][] = [];
  for (let index = 1; index <= dataRows; index += 1) {
    if (blankEvery && index > 1 && (index - 1) % blankEvery === 0) rows.push([]);
    rows.push(importDataRow(index, options));
  }
  return rows;
}

function quoteCsv(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

export function buildImportCsv(
  dataRows: number,
  blankEvery = 0,
  options: ImportRowFixtureOptions = {},
) {
  return Buffer.from(
    `\uFEFF${[importHeaders, ...rowsWithBlanks(dataRows, blankEvery, options)]
      .map((row) => row.map(quoteCsv).join(","))
      .join("\r\n")}`,
    "utf8",
  );
}

export async function buildImportXlsx(
  dataRows: number,
  blankEvery = 0,
  options: ImportRowFixtureOptions = {},
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("导入");
  sheet.addRow(importHeaders);
  for (const row of rowsWithBlanks(dataRows, blankEvery, options)) sheet.addRow(row);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

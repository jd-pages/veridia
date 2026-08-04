import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { E2E_ORIGIN } from "./e2e-origin";

const headers = [
  "登记时间",
  "渠道",
  "店铺名称",
  "客户备注",
  "买家购买ID",
  "购买订单号",
  "购买时间",
  "购买罐数",
  "参与次数",
  "发布小红书账号",
  "小红书发布链接",
  "购买产品线",
  "是否符合",
];

test("佳贝艾特13列模板下载、识别和六种购买产品线预检", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const templateResponse = await page.request.get(
    "/api/import/template?format=xlsx&brand=kabrita",
  );
  expect(templateResponse.ok()).toBeTruthy();
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(
    (await templateResponse.body()) as unknown as ExcelJS.Buffer,
  );
  expect(
    (templateWorkbook.worksheets[0].getRow(1).values as unknown[]).slice(1),
  ).toEqual(headers);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("佳贝艾特导入");
  sheet.addRow(headers);
  const productLines = [
    "荷兰佳贝1",
    "荷兰佳贝2",
    "荷兰佳贝3",
    "港版佳贝1",
    "港版佳贝2",
    "港版佳贝3",
  ];
  productLines.forEach((productLine, index) => {
    sheet.addRow([
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      `标题 ${E2E_ORIGIN}/mock/xhs?case=passed&kabrita=${index + 1}`,
      productLine,
      "",
    ]);
  });

  const previewResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "佳贝艾特审核模板.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  const payload = await previewResponse.json();
  expect(
    previewResponse.ok(),
    `佳贝艾特预检失败：${JSON.stringify(payload)}`,
  ).toBeTruthy();
  const preview = payload.data as {
    templateBrand: string;
    sourceLabel: string;
    validCount: number;
    invalidCount: number;
    recognizedFields: Array<{ header: string }>;
    rows: Array<{
      purchaseProductLine: string;
      productName: string;
      errors: string[];
    }>;
  };
  expect(preview).toMatchObject({
    templateBrand: "佳贝艾特",
    sourceLabel: "佳贝艾特 Excel",
    validCount: 6,
    invalidCount: 0,
  });
  expect(preview.recognizedFields.map((field) => field.header)).toEqual(headers);
  expect(preview.rows.map((row) => row.purchaseProductLine)).toEqual(
    productLines,
  );
  expect(preview.rows.slice(0, 3).map((row) => row.productName)).toEqual([
    "佳贝艾特荷兰版",
    "佳贝艾特荷兰版",
    "佳贝艾特荷兰版",
  ]);
  expect(preview.rows.slice(3).map((row) => row.productName)).toEqual([
    "佳贝艾特港版",
    "佳贝艾特港版",
    "佳贝艾特港版",
  ]);
  expect(preview.rows.flatMap((row) => row.errors)).toEqual([]);
});

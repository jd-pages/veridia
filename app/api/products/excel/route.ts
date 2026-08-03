import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { cellText, excelResponse } from "@/lib/excel";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  businessStatusLabel,
  internalStatusValue,
} from "@/lib/zh-CN";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const products = await prisma.product.findMany({
    include: { aliases: true },
    orderBy: { code: "asc" },
  });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("产品");
  sheet.columns = [
    { header: "产品编码", key: "code", width: 20 },
    { header: "产品名称", key: "name", width: 28 },
    { header: "品牌名称", key: "brand", width: 20 },
    { header: "产品分类", key: "category", width: 20 },
    { header: "产品别名", key: "aliases", width: 38 },
    { header: "状态", key: "status", width: 14 },
  ];
  products.forEach((product) =>
    sheet.addRow({
      code: product.code,
      name: product.name,
      brand: product.brandName,
      category: product.category,
      aliases: product.aliases.map((item) => item.alias).join("；"),
      status: businessStatusLabel(product.status),
    }),
  );
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFB4232A" },
  };
  return excelResponse(await workbook.xlsx.writeBuffer(), "产品数据.xlsx");
}

export async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("请选择 Excel 文件");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) return fail("Excel 中没有工作表");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => headers.set(cellText(cell), col));
  const rows = [];
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const get = (name: string) => cellText(row.getCell(headers.get(name) || 0));
    const code = get("产品编码");
    const name = get("产品名称");
    const brandName = get("品牌名称");
    if (!code && !name) continue;
    if (!code || !name || !brandName) {
      rows.push({ row: index, success: false, reason: "编码、名称、品牌不能为空" });
      continue;
    }
    await prisma.product.upsert({
      where: { code },
      create: {
        code,
        name,
        brandName,
        category: get("产品分类") || null,
        aliases: {
          create: get("产品别名")
            .split(/[；;]/)
            .map((alias) => alias.trim())
            .filter(Boolean)
            .map((alias) => ({ alias })),
        },
      },
      update: {
        name,
        brandName,
        category: get("产品分类") || null,
        status: internalStatusValue(get("状态")),
      },
    });
    rows.push({ row: index, success: true });
  }
  return ok({ rows });
}

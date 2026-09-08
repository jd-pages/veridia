import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { buildImportedTaskNotes } from "../../lib/import-task-metadata";
import { createAuditIngestFixture, auditIngestExtraction } from "../helpers/audit-ingest-fixture";
import { csvCells, csvDangerousTextCases, csvNormalTexts } from "../helpers/csv-export-safety";

test("A09: task CSV preserves dangerous and ordinary business text through the real API", async ({ request }) => {
  test.setTimeout(120_000);
  if (!process.env.E2E_DATABASE_URL) throw new Error("Isolated E2E database required");
  const db = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL });
  const fixture = await createAuditIngestFixture(db);
  try {
    expect((await request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).status()).toBe(200);
    const inputs = [...csvDangerousTextCases.map(c => ({ value: c.value, expected: `'${c.value}` })),
      ...csvNormalTexts.map(value => ({ value, expected: value }))];
    const tasks = [];
    for (const input of inputs) tasks.push(await fixture.task({ notes: input.value }));
    const response = await request.get("/api/tasks/export?format=csv");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    const bytes = await response.body();
    expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
    const rows = csvCells(bytes.toString("utf8"));
    tasks.forEach((task, index) => {
      const row = rows.find(cells => cells.includes(task.url));
      expect(row).toHaveLength(rows[0].length);
      expect(row).toContain(inputs[index].expected);
    });
  } finally {
    try { await fixture.cleanup(); } finally { await db.$disconnect(); }
  }
});

test("A09: single and mixed brand result CSV is safe while XLSX keeps string cells", async ({ request }) => {
  test.setTimeout(120_000);
  if (!process.env.E2E_DATABASE_URL) throw new Error("Isolated E2E database required");
  const db = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL });
  const danone = await createAuditIngestFixture(db);
  const kabrita = await createAuditIngestFixture(db);
  try {
    expect((await request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).status()).toBe(200);
    await db.product.update({ where: { id: kabrita.product.id }, data: { brandName: "佳贝艾特" } });
    const values = ["=1+1", "+1+1", "-1+1", "@SUM(1,1)", ' \t=1+1\r\n"中文",🙂'];
    const groups: string[][] = [];
    for (const fixture of [danone, kabrita]) {
      const ids: string[] = [];
      for (const value of values) {
        const notes = buildImportedTaskNotes({ templateMetadata: fixture === danone
          ? { templateType: "DANONE_CUSTOMER", rawValues: { productName: value } }
          : { templateType: "KABRITA", templateBrand: "佳贝艾特", rawValues: { customerRemark: value } } });
        const task = await fixture.task({ notes });
        const response = await request.post(`/api/tasks/${task.id}/audit`, { data: { extraction: auditIngestExtraction(task) } });
        expect(response.status(), await response.text()).toBe(200);
        ids.push((await response.json()).data.id);
      }
      groups.push(ids);
    }
    for (const ids of [...groups, groups.flat()]) {
      const query = new URLSearchParams({ ids: ids.join(","), format: "csv" });
      const response = await request.get(`/api/results/export?${query}`);
      expect(response.status(), await response.text()).toBe(200);
      const bytes = await response.body();
      expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
      const rows = csvCells(bytes.toString("utf8"));
      for (const value of values) expect(rows.filter(row => row.includes(`'${value}`))).toHaveLength(ids.length / values.length);
      query.set("format", "xlsx");
      const xlsx = await request.get(`/api/results/export?${query}`);
      expect(xlsx.status()).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(await xlsx.body()).buffer);
      const strings: string[] = [];
      workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
        expect(cell.formula).toBeUndefined();
        if (cell.type === ExcelJS.ValueType.String) strings.push(String(cell.value));
      })));
      for (const value of values.slice(0, 4)) expect(strings.filter(text => text === value)).toHaveLength(ids.length / values.length);
    }
  } finally {
    try { await danone.cleanup(); await kabrita.cleanup(); } finally { await db.$disconnect(); }
  }
});

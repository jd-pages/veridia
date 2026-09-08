import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BUILTIN_IMPORT_EXPORT_TEMPLATES as templates } from "@/lib/import-export-templates/config";
import { buildConfiguredCsv, buildBrandedAuditResultsCsv, buildConfiguredWorkbook, buildImportTemplateCsv } from "@/lib/import-export-templates/export";
import { utf8BomCsv } from "@/lib/import-export-templates/tabular";
import { csvCells, csvDangerousTextCases, csvNormalTexts } from "../helpers/csv-export-safety";

describe("A09 final CSV text semantics", () => {
  it.each(csvDangerousTextCases)("business text $name stays text in task and result CSV", ({ value }) => {
    for (const kind of ["auditTasks", "auditResults"] as const) {
      const csv = buildConfiguredCsv({ templates, kind, records: [{ productName: value }] });
      const rows = csvCells(csv);
      const index = templates.columnOrder[kind].indexOf("productName");
      expect(rows).toHaveLength(2);
      expect(rows[1]).toHaveLength(rows[0].length);
      expect(rows[1][index]).toBe(`'${value}`);
      expect(rows[1][index].slice(1)).toBe(value);
    }
  });

  it.each(csvNormalTexts.map((value, index) => ({ value, name: `control ${index}` })))("$name remains byte-for-byte business text", ({ value }) => {
    const csv = buildConfiguredCsv({ templates, kind: "auditTasks", records: [{ remark: value }] });
    expect(csvCells(csv)[1][templates.columnOrder.auditTasks.indexOf("remark")]).toBe(value);
  });

  it("headers, configured examples and mixed-brand rows use the same protection", () => {
    const custom = structuredClone(templates);
    custom.fieldDefinitions.remark.displayName = "\t=1+1";
    custom.examples.productName = "+1+1";
    const task = csvCells(buildConfiguredCsv({ templates: custom, kind: "auditTasks", records: [{ remark: "=1+1" }] }));
    expect(task[0][custom.columnOrder.auditTasks.indexOf("remark")]).toBe("'\t=1+1");
    expect(task[1][custom.columnOrder.auditTasks.indexOf("remark")]).toBe("'=1+1");
    const template = csvCells(buildImportTemplateCsv(custom));
    expect(template[1][custom.columnOrder.import.indexOf("productName")]).toBe("'+1+1");
    const mixed = buildBrandedAuditResultsCsv({ templates, sections: [
      { title: "达能审核结果", records: [{ productName: "=1+1" }] },
      { title: "佳贝艾特审核结果", templateBrand: "佳贝艾特", records: [{ customerRemark: "@SUM(1,1)" }] },
    ] });
    expect(mixed.match(/\uFEFF/gu)).toHaveLength(1);
    const rows = csvCells(mixed);
    expect(rows[0]).toEqual(["达能审核结果"]);
    expect(rows[2]).toContain("'=1+1");
    expect(rows[3]).toEqual([""]);
    expect(rows[4]).toEqual(["佳贝艾特审核结果"]);
    expect(rows[6]).toContain("'@SUM(1,1)");
    expect(rows[2]).toHaveLength(rows[1].length);
    expect(rows[6]).toHaveLength(rows[5].length);
  });

  it("CSV BOM, CRLF, typed scalars and nullish values retain their contract", () => {
    const csv = utf8BomCsv(["text", "number", "boolean", "empty", "missing"], [["-12", -12, false, null, undefined], ["中文🙂", 0.5, true, "", "a,\"b\"\r\nc"]]);
    expect([...Buffer.from(csv).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csvCells(csv)).toEqual([
      ["text", "number", "boolean", "empty", "missing"],
      ["'-12", "-12", "false", "", ""], ["中文🙂", "0.5", "true", "", "a,\"b\"\r\nc"],
    ]);
    expect(csv).toContain('"\'-12",-12,false,,\r\n');
    const date = new Date("2026-09-08T12:34:56Z");
    const rows = csvCells(buildConfiguredCsv({ templates, kind: "auditTasks", records: [{ reviewedAt: date }] }));
    expect(rows[1][templates.columnOrder.auditTasks.indexOf("reviewedAt")]).toBe(date.toLocaleString("zh-CN", { hour12: false }));
  });

  it("XLSX retains real string cells without CSV markers or formula objects", async () => {
    const values = [...csvDangerousTextCases.map(c => c.value), ...csvNormalTexts.slice(0, -1)];
    const bytes = await buildConfiguredWorkbook({ templates, kind: "auditTasks", records: values.map(remark => ({ remark })) });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const column = templates.columnOrder.auditTasks.indexOf("remark") + 1;
    values.forEach((value, index) => {
      const cell = workbook.worksheets[0].getCell(index + 2, column);
      expect(cell.formula).toBeUndefined();
      // XML newline/control normalization already exists in the XLSX writer.
      // Exact preservation is asserted where XML does not normalize the input.
      if (!/\p{Cc}/u.test(value)) {
        expect(cell.value).toBe(value || null);
      }
      if (value) expect(String(cell.value).startsWith("'")).toBe(value.startsWith("'"));
      expect(cell.type).toBe(value ? ExcelJS.ValueType.String : ExcelJS.ValueType.Null);
    });
  });
});

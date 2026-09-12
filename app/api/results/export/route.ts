import { prisma } from "@/lib/db";
import {
  fail,
  requireApiUser,
  withApiErrorBoundary,
} from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  auditResultToCompactExportRecord,
  auditResultToKabritaExportRecord,
  auditResultToWyethNestleExportRecord,
  buildBrandedAuditResultsCsv,
  buildConfiguredCsv,
  buildConfiguredWorkbook,
  buildUnifiedAuditResultsWorkbook,
} from "@/lib/import-export-templates/export";
import {
  DANONE_BRAND_NAME,
  KABRITA_BRAND_NAME,
} from "@/lib/import-export-templates/kabrita";
import {
  NESTLE_BRAND_NAME,
  WYETH_BRAND_NAME,
  WYETH_NESTLE_FIELDS,
} from "@/lib/import-export-templates/wyeth-nestle";
import { WYETH_NESTLE_SHEET_NAME } from "@/lib/import-template-type";
import {
  DANONE_MIXED_SUMMARY_FIELDS,
  type ImportTemplateType,
} from "@/lib/import-template-type";
import { importedTemplateMetadataFromNotes } from "@/lib/import-task-metadata";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";
import {
  buildAuditResultWhere,
  readResultQueryFilters,
} from "@/lib/result-query";
import { auditResultExportFileName } from "@/lib/result-export-file-name";
import { sortAuditResultsByImportOrder } from "@/lib/result-export-order";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { resolveAuditEvidenceFilterIds } from "@/lib/audit-evidence-query";

type UnifiedResultSheetType = "DANONE" | "KABRITA" | "WYETH_NESTLE";

function unifiedResultSheetType(row: {
  task: { notes: string | null; product: { brandName?: string | null } };
}): { type: UnifiedResultSheetType | null; error: string } {
  const brandName = row.task.product.brandName?.trim() || "";
  const templateType = importedTemplateMetadataFromNotes(row.task.notes)?.templateType;
  const expected = templateType === "KABRITA"
    ? "KABRITA"
    : templateType === "WYETH_NESTLE"
      ? "WYETH_NESTLE"
      : templateType === "DANONE_CUSTOMER" || templateType === "DANONE_AGENCY"
        ? "DANONE"
        : brandName === KABRITA_BRAND_NAME
          ? "KABRITA"
          : brandName === DANONE_BRAND_NAME
            ? "DANONE"
            : brandName === WYETH_BRAND_NAME || brandName === NESTLE_BRAND_NAME
              ? "WYETH_NESTLE"
              : null;
  const valid = expected === "DANONE"
    ? brandName === DANONE_BRAND_NAME
    : expected === "KABRITA"
      ? brandName === KABRITA_BRAND_NAME
      : expected === "WYETH_NESTLE"
        ? brandName === WYETH_BRAND_NAME || brandName === NESTLE_BRAND_NAME
        : false;
  return valid
    ? { type: expected, error: "" }
    : {
        type: null,
        error: `审核任务模板类型与正式品牌不一致：templateType=${templateType || "MISSING"}，brandName=${brandName || "MISSING"}`,
      };
}

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const filters = readResultQueryFilters(searchParams);
  const importBatch = filters.importRecordId
    ? await prisma.importRecord.findUnique({
        where: { id: filters.importRecordId },
        select: { id: true, fileName: true, createdAt: true },
      })
    : null;
  await backfillMissingProcessingFailureResults();
  let where;
  try {
    const evidenceFilters = await resolveAuditEvidenceFilterIds({
      keyword: filters.keyword,
      includeProcessingFailures: filters.status === "PROCESS_FAILED",
    });
    where = buildAuditResultWhere(
      filters,
      evidenceFilters,
    );
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "筛选条件不正确",
      400,
    );
  }
  const foundRows = await prisma.auditResult.findMany({
    where,
    include: {
      note: { select: { id: true } },
      extractionRecord: true,
      task: {
        include: {
          product: true,
          campaign: true,
          batch: true,
          importRecord: true,
        },
      },
      manualReviews: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });
  const rows = sortAuditResultsByImportOrder(foundRows.map((result) => {
    const snapshot = withAuditExtractionSnapshot(result);
    return {
      ...snapshot,
      note: {
        ...snapshot.note,
        // Export writers expect Date cells; retain the bound evidence timestamp.
        // Imported registration dates continue to take precedence in the mapper.
        publishedAt: snapshot.note.publishedAt ? new Date(snapshot.note.publishedAt) : null,
      },
    };
  }));
  if (!rows.length) {
    console.info(
      "[审核结果导出] 未生成文件",
      JSON.stringify({
        count: 0,
        filterKeys: Object.entries(filters)
          .filter(([, value]) =>
            Array.isArray(value) ? value.length > 0 : Boolean(value),
          )
          .map(([key]) => key),
      }),
    );
    return fail(
      "当前筛选无结果，未生成文件",
      404,
      "NO_EXPORT_RESULTS",
    );
  }
  const { templates } = await getActiveImportExportTemplates();
  const wyethNestleBrands = new Set<string>([
    WYETH_BRAND_NAME,
    NESTLE_BRAND_NAME,
  ]);
  const kabritaRows = rows.filter(
    (row) => row.task.product.brandName?.trim() === KABRITA_BRAND_NAME,
  );
  const wyethNestleRows = rows.filter((row) =>
    wyethNestleBrands.has(row.task.product.brandName?.trim() || ""),
  );
  const danoneRows = rows.filter(
    (row) =>
      row.task.product.brandName?.trim() !== KABRITA_BRAND_NAME &&
      !wyethNestleBrands.has(row.task.product.brandName?.trim() || ""),
  );
  const danoneTemplateType = (row: (typeof danoneRows)[number]): ImportTemplateType =>
    importedTemplateMetadataFromNotes(row.task.notes)?.templateType ===
    "DANONE_AGENCY"
      ? "DANONE_AGENCY"
      : "DANONE_CUSTOMER";
  const danoneAgencyRows = danoneRows.filter(
    (row) => danoneTemplateType(row) === "DANONE_AGENCY",
  );
  const danoneCustomerRows = danoneRows.filter(
    (row) => danoneTemplateType(row) === "DANONE_CUSTOMER",
  );
  const mixedDanoneTemplates =
    danoneAgencyRows.length > 0 && danoneCustomerRows.length > 0;
  const useKabritaTemplate = kabritaRows.length === rows.length;
  const useWyethNestleTemplate = wyethNestleRows.length === rows.length;
  const mixedBrands = [danoneRows, kabritaRows, wyethNestleRows].filter(
    (group) => group.length > 0,
  ).length > 1;
  const templateBrand = useKabritaTemplate
    ? KABRITA_BRAND_NAME
    : undefined;
  const records = useKabritaTemplate
    ? kabritaRows.map(auditResultToKabritaExportRecord)
    : useWyethNestleTemplate
      ? wyethNestleRows.map(auditResultToWyethNestleExportRecord)
      : danoneRows.map(auditResultToCompactExportRecord);
  const agencyRecords = danoneAgencyRows.map(auditResultToCompactExportRecord);
  const customerRecords = danoneCustomerRows.map(auditResultToCompactExportRecord);
  const kabritaRecords = kabritaRows.map(auditResultToKabritaExportRecord);
  const wyethNestleRecords = wyethNestleRows.map(
    auditResultToWyethNestleExportRecord,
  );
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const fileName = auditResultExportFileName({
    kabrita: useKabritaTemplate,
    selected: Boolean(filters.ids?.length),
    extension: format,
    importBatch,
    danoneMixed: mixedDanoneTemplates && !mixedBrands,
  });
  const exportLog = async (format: "csv" | "xlsx", bytes: number) => {
    const filterKeys = Object.entries(filters)
      .filter(([, value]) =>
        Array.isArray(value) ? value.length > 0 : Boolean(value),
      )
      .map(([key]) => key);
    console.info(
      "[审核结果导出] 文件生成完成",
      JSON.stringify({
        count: rows.length,
        format,
        bytes,
        importRecordId: importBatch?.id || null,
        fileName: importBatch?.fileName || null,
        importedAt: importBatch?.createdAt || null,
        filterKeys,
        operator: user.id,
      }),
    );
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "EXPORT_AUDIT_RESULTS",
        entityType: importBatch ? "IMPORT_RECORD" : "AUDIT_RESULT",
        entityId: importBatch?.id || null,
        summary: `导出审核结果 ${rows.length} 条`,
        metadata: JSON.stringify({
          importRecordId: importBatch?.id || null,
          fileName: importBatch?.fileName || null,
          importedAt: importBatch?.createdAt || null,
          filterKeys,
          exportCount: rows.length,
          format,
          exportTime: new Date().toISOString(),
        }),
      },
    });
  };
  if (format === "xlsx" && importBatch) {
    const classified = rows.map((row) => ({
      row,
      classification: unifiedResultSheetType(row),
    }));
    const invalid = classified.find(({ classification }) => !classification.type);
    if (invalid) {
      return fail(
        `统一审核结果导出已阻断：${invalid.classification.error}`,
        409,
        "RESULT_SHEET_CLASSIFICATION_FAILED",
      );
    }
    const byType = (type: UnifiedResultSheetType) => classified
      .filter(({ classification }) => classification.type === type)
      .map(({ row }) => row);
    const unifiedDanoneRows = byType("DANONE");
    const unifiedKabritaRows = byType("KABRITA");
    const unifiedWyethNestleRows = byType("WYETH_NESTLE");
    const buffer = await buildUnifiedAuditResultsWorkbook({
      templates,
      danoneRecords: unifiedDanoneRows.map(auditResultToCompactExportRecord),
      kabritaRecords: unifiedKabritaRows.map(auditResultToKabritaExportRecord),
      wyethNestleRecords: unifiedWyethNestleRows.map(
        auditResultToWyethNestleExportRecord,
      ),
    });
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    if (bytes.byteLength < 1_024) {
      return fail("导出文件生成异常，请稍后重试", 500, "EMPTY_EXPORT_FILE");
    }
    await exportLog("xlsx", bytes.byteLength);
    return new Response(bytes, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
        "X-Veridia-Export-Count": String(rows.length),
        "X-Veridia-Export-Workbook": "UNIFIED",
      },
    });
  }
  if (format === "csv") {
    const csv = mixedBrands
      ? buildBrandedAuditResultsCsv({
          templates,
          sections: [
            ...(danoneRows.length
              ? [{ title: "达能审核结果", records: danoneRows.map(auditResultToCompactExportRecord) }]
              : []),
            ...(kabritaRows.length ? [{
              title: "佳贝艾特审核结果",
              records: kabritaRecords,
              templateBrand: KABRITA_BRAND_NAME,
            }] : []),
            ...(wyethNestleRows.length ? [{
              title: "惠氏/雀巢审核结果",
              records: wyethNestleRecords,
              templateType: "WYETH_NESTLE" as const,
              fields: WYETH_NESTLE_FIELDS,
            }] : []),
          ],
        })
      : buildConfiguredCsv({
          templates,
          kind: "auditResults",
          records,
          templateBrand,
          ...(useWyethNestleTemplate
            ? {
                templateType: "WYETH_NESTLE" as const,
                fields: WYETH_NESTLE_FIELDS,
              }
            : {}),
        });
    const byteLength = new TextEncoder().encode(csv).byteLength;
    if (byteLength < 1) {
      return fail("导出文件生成异常，请稍后重试", 500, "EMPTY_EXPORT_FILE");
    }
    await exportLog("csv", byteLength);
    return new Response(
      csv,
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Cache-Control": "no-store",
          "X-Veridia-Export-Count": String(rows.length),
        },
      },
    );
  }
  const buffer = await buildConfiguredWorkbook({
    templates,
    kind: "auditResults",
    records,
    templateBrand,
    templateType:
      useWyethNestleTemplate
        ? "WYETH_NESTLE"
        : !mixedBrands && !mixedDanoneTemplates && agencyRecords.length
        ? "DANONE_AGENCY"
        : !mixedBrands && !mixedDanoneTemplates && customerRecords.length
          ? "DANONE_CUSTOMER"
          : undefined,
    ...(useWyethNestleTemplate
      ? {
          sections: [{
            sheetName: WYETH_NESTLE_SHEET_NAME,
            records: wyethNestleRecords,
            templateType: "WYETH_NESTLE" as const,
            fields: WYETH_NESTLE_FIELDS,
          }],
        }
      : mixedDanoneTemplates && !mixedBrands
      ? {
          sections: [
            {
              sheetName: "审核结果汇总",
              records,
              templateType: "DANONE_CUSTOMER" as const,
              fields: DANONE_MIXED_SUMMARY_FIELDS,
            },
            {
              sheetName: "达能代发",
              records: agencyRecords,
              templateType: "DANONE_AGENCY" as const,
            },
            {
              sheetName: "达能客户",
              records: customerRecords,
              templateType: "DANONE_CUSTOMER" as const,
            },
          ],
        }
      : mixedBrands
      ? {
          sections: [
            ...(danoneRows.length && mixedDanoneTemplates
              ? [
                  {
                    sheetName: "达能审核结果汇总",
                    records,
                    templateType: "DANONE_CUSTOMER" as const,
                    fields: DANONE_MIXED_SUMMARY_FIELDS,
                  },
                  {
                    sheetName: "达能代发",
                    records: agencyRecords,
                    templateType: "DANONE_AGENCY" as const,
                  },
                  {
                    sheetName: "达能客户",
                    records: customerRecords,
                    templateType: "DANONE_CUSTOMER" as const,
                  },
                ]
              : danoneRows.length ? [
                  {
                    sheetName: "达能审核结果",
                    records: danoneRows.map(auditResultToCompactExportRecord),
                    templateType: agencyRecords.length
                      ? "DANONE_AGENCY" as const
                      : "DANONE_CUSTOMER" as const,
                  },
                ] : []),
            ...(kabritaRows.length ? [{
              sheetName: "佳贝艾特审核结果",
              records: kabritaRecords,
              templateBrand: KABRITA_BRAND_NAME,
            }] : []),
            ...(wyethNestleRows.length
              ? [{
                  sheetName: WYETH_NESTLE_SHEET_NAME,
                  records: wyethNestleRecords,
                  templateType: "WYETH_NESTLE" as const,
                  fields: WYETH_NESTLE_FIELDS,
                }]
              : []),
          ],
        }
      : {}),
  });
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  if (bytes.byteLength < 1_024) {
    return fail("导出文件生成异常，请稍后重试", 500, "EMPTY_EXPORT_FILE");
  }
  await exportLog("xlsx", bytes.byteLength);
  return new Response(bytes, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
      "X-Veridia-Export-Count": String(rows.length),
    },
  });
}, "导出审核结果");

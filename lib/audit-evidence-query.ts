import { prisma } from "@/lib/db";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { currentAuditResultWhere } from "@/lib/audit-result-lifecycle";
import { processingFailureTaskStatuses } from "@/lib/processing-failure";

// SQLite's default LIKE folds ASCII case only. Keep that existing search
// behavior without depending on the production database's collation.
function foldAsciiCase(value: string) {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/** Resolve filters from the same verified evidence used by result presentation.
 * JSON diagnostic strings and the mutable NoteRecord are never search evidence.
 * Legacy matching remains an explicit branch in the calling query builder. */
export async function resolveAuditEvidenceFilterIds(input: {
  keyword?: string;
  includeProcessingFailures?: boolean;
}) {
  const keywordIds: string[] = [];
  const processingFailureIds: string[] = [];
  const keyword = input.keyword ? foldAsciiCase(input.keyword) : "";
  if (!keyword && !input.includeProcessingFailures) return { keywordIds, processingFailureIds };

  let cursor: string | undefined;
  while (true) {
    const results = await prisma.auditResult.findMany({
      where: { ...currentAuditResultWhere, extractionRecordId: { not: null } },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, auditTaskId: true, extractionRecordId: true, auditedAt: true,
        autoStatus: true, pageStatus: true, noteType: true,
        imageExtractionStatus: true, imageCount: true,
        note: { select: { id: true } },
        task: { select: { url: true, finalUrl: true, channel: true } },
        extractionRecord: { select: { id: true, auditTaskId: true, rawData: true, extractedAt: true } },
      },
    });
    for (const result of results) {
      const snapshot = withAuditExtractionSnapshot(result);
      if (snapshot.evidenceStatus !== "RESULT_BOUND") continue;
      if (keyword && [snapshot.note.title, snapshot.note.body, snapshot.note.url,
        snapshot.note.platformNoteId, snapshot.note.finalUrl].some((value) =>
        typeof value === "string" && foldAsciiCase(value).includes(keyword),
      )) keywordIds.push(result.id);
      if (input.includeProcessingFailures &&
          (processingFailureTaskStatuses as readonly string[]).includes(snapshot.task.status)) {
        processingFailureIds.push(result.id);
      }
    }
    if (results.length < 500) return { keywordIds, processingFailureIds };
    cursor = results[results.length - 1].id;
  }
}

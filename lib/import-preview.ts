export interface ImportPreviewRowLike {
  errors: string[];
}

export function selectImportPreviewRows<T extends ImportPreviewRowLike>(
  rows: T[],
  limit: number,
) {
  const safeLimit = Math.max(0, limit);
  const errorRows = rows.filter((row) => row.errors.length > 0);

  return {
    rows: rows.slice(0, safeLimit),
    errorRows: errorRows.slice(0, safeLimit),
    rowsTruncated: rows.length > safeLimit,
    errorRowsTruncated: errorRows.length > safeLimit,
  };
}

export interface ResultStatusGroup {
  autoStatus: string;
  pageStatus: string;
  _count: { _all: number };
}

export interface ResultStatusNormalizations {
  passed?: Partial<Record<string, number>>;
  failed?: Partial<Record<string, number>>;
  review?: Partial<Record<string, number>>;
}

const storedNotFoundPageStatuses = new Set([
  "NOTE_NOT_FOUND",
  "NOT_FOUND",
  "DELETED",
]);

export function summarizeResultStatusGroups(
  groups: ResultStatusGroup[],
  additionalNotFound: number,
  normalizations: ResultStatusNormalizations = {},
) {
  const statusCounts: Record<string, number> = {};
  let total = 0;
  let passed = 0;
  let failed = 0;
  let review = 0;
  let storedNotFound = 0;
  for (const group of groups) {
    const count = group._count._all;
    total += count;
    statusCounts[group.autoStatus] =
      (statusCounts[group.autoStatus] || 0) + count;
    const isStoredNotFound =
      group.autoStatus === "NOTE_NOT_FOUND" ||
      storedNotFoundPageStatuses.has(group.pageStatus);
    if (isStoredNotFound) {
      storedNotFound += count;
      continue;
    }
    if (group.autoStatus === "PASSED") passed += count;
    if (group.autoStatus === "FAILED") failed += count;
    if (group.autoStatus === "NEEDS_REVIEW") review += count;
  }

  for (const [source, count] of Object.entries(normalizations.passed || {})) {
    if (source === "PASSED") continue;
    if (source === "FAILED") failed = Math.max(0, failed - (count || 0));
    if (source === "NEEDS_REVIEW") review = Math.max(0, review - (count || 0));
    passed += count || 0;
  }
  for (const [source, count] of Object.entries(normalizations.failed || {})) {
    if (source === "FAILED") continue;
    if (source === "PASSED") passed = Math.max(0, passed - (count || 0));
    if (source === "NEEDS_REVIEW") review = Math.max(0, review - (count || 0));
    failed += count || 0;
  }
  for (const [source, count] of Object.entries(normalizations.review || {})) {
    if (source === "NEEDS_REVIEW") continue;
    if (source === "PASSED") passed = Math.max(0, passed - (count || 0));
    if (source === "FAILED") failed = Math.max(0, failed - (count || 0));
    review += count || 0;
  }

  // Persisted PENDING_RETENTION is consumed by one of the normalized buckets.
  const normalizedPending = (normalizations.passed?.PENDING_RETENTION || 0) +
    (normalizations.failed?.PENDING_RETENTION || 0) +
    (normalizations.review?.PENDING_RETENTION || 0);
  const unresolvedPending = Math.max(
    0,
    (statusCounts.PENDING_RETENTION || 0) - normalizedPending,
  );
  // Defensive compatibility: an unclassified legacy pending row is reviewable,
  // never silently counted as passed.
  review += unresolvedPending;

  statusCounts.ALL = total;
  statusCounts.PASSED = passed;
  statusCounts.FAILED = failed;
  statusCounts.NEEDS_REVIEW = review;
  delete statusCounts.PENDING_RETENTION;
  const notFound = storedNotFound + additionalNotFound;
  statusCounts.NOTE_NOT_FOUND = notFound;
  return { total, passed, failed, notFound, review, statusCounts };
}

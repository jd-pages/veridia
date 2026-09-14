export interface ResultStatusGroup {
  autoStatus: string;
  pageStatus: string;
  _count: { _all: number };
}

const storedNotFoundPageStatuses = new Set([
  "NOTE_NOT_FOUND",
  "NOT_FOUND",
  "DELETED",
]);

export function summarizeResultStatusGroups(
  groups: ResultStatusGroup[],
  additionalNotFound: number,
  legacyRetentionOnlyPending: Partial<Record<string, number>> = {},
  retentionManualReview: Partial<Record<string, number>> = {},
) {
  const statusCounts: Record<string, number> = {};
  let total = 0;
  let passed = 0;
  let failed = 0;
  let review = 0;
  let pendingRetention = 0;
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
    if (group.autoStatus === "PENDING_RETENTION") pendingRetention += count;
  }
  const normalizedPending = Object.values(legacyRetentionOnlyPending).reduce<number>(
    (total, count) => total + (count || 0),
    0,
  );
  passed = Math.max(0, passed - (legacyRetentionOnlyPending.PASSED || 0));
  review = Math.max(
    0,
    review - (legacyRetentionOnlyPending.NEEDS_REVIEW || 0),
  );
  pendingRetention += normalizedPending;
  passed = Math.max(0, passed - (retentionManualReview.PASSED || 0));
  failed = Math.max(0, failed - (retentionManualReview.FAILED || 0));
  pendingRetention = Math.max(
    0,
    pendingRetention - (retentionManualReview.PENDING_RETENTION || 0),
  );
  review += Object.entries(retentionManualReview).reduce(
    (total, [status, count]) =>
      total + (status === "NEEDS_REVIEW" ? 0 : count || 0),
    0,
  );
  statusCounts.ALL = total;
  statusCounts.PASSED = passed;
  statusCounts.FAILED = failed;
  statusCounts.NEEDS_REVIEW = review;
  statusCounts.PENDING_RETENTION = pendingRetention;
  const notFound = storedNotFound + additionalNotFound;
  statusCounts.NOTE_NOT_FOUND = notFound;
  return {
    total,
    passed,
    failed,
    notFound,
    review,
    pendingRetention,
    statusCounts,
  };
}

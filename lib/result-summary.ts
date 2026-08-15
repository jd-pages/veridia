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
  statusCounts.ALL = total;
  statusCounts.PASSED = passed;
  statusCounts.FAILED = failed;
  statusCounts.NEEDS_REVIEW = review;
  const notFound = storedNotFound + additionalNotFound;
  statusCounts.NOTE_NOT_FOUND = notFound;
  return { total, passed, failed, notFound, review, statusCounts };
}

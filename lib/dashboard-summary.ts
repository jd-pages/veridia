export interface DashboardStatusGroup {
  autoStatus: string;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  _count: { _all: number };
}

export function summarizeDashboardStatusGroups(
  groups: DashboardStatusGroup[],
  legacyRetentionOnlyPending: Partial<Record<string, number>> = {},
  retentionManualReview: Partial<Record<string, number>> = {},
) {
  const counts = {
    total: 0,
    passed: 0,
    failed: 0,
    needsReview: 0,
    readFailed: 0,
    topicMissing: 0,
    clickableAbnormal: 0,
    pendingRetention: 0,
  };
  for (const group of groups) {
    const count = group._count._all;
    counts.total += count;
    if (group.autoStatus === "PASSED") counts.passed += count;
    if (group.autoStatus === "FAILED") counts.failed += count;
    if (group.autoStatus === "NEEDS_REVIEW") counts.needsReview += count;
    if (group.autoStatus === "READ_FAILED") counts.readFailed += count;
    if (group.autoStatus === "PENDING_RETENTION") counts.pendingRetention += count;
    if (!group.topicsCompliant) counts.topicMissing += count;
    if (!group.clickableCompliant) counts.clickableAbnormal += count;
  }
  counts.passed = Math.max(
    0,
    counts.passed - (legacyRetentionOnlyPending.PASSED || 0),
  );
  counts.needsReview = Math.max(
    0,
    counts.needsReview - (legacyRetentionOnlyPending.NEEDS_REVIEW || 0),
  );
  counts.pendingRetention += Object.values(legacyRetentionOnlyPending).reduce<number>(
    (total, count) => total + (count || 0),
    0,
  );
  counts.passed = Math.max(
    0,
    counts.passed - (retentionManualReview.PASSED || 0),
  );
  counts.failed = Math.max(
    0,
    counts.failed - (retentionManualReview.FAILED || 0),
  );
  counts.pendingRetention = Math.max(
    0,
    counts.pendingRetention - (retentionManualReview.PENDING_RETENTION || 0),
  );
  counts.needsReview += Object.entries(retentionManualReview).reduce(
    (total, [status, count]) =>
      total + (status === "NEEDS_REVIEW" ? 0 : count || 0),
    0,
  );
  return counts;
}

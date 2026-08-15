export interface DashboardStatusGroup {
  autoStatus: string;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  _count: { _all: number };
}

export function summarizeDashboardStatusGroups(
  groups: DashboardStatusGroup[],
) {
  const counts = {
    total: 0,
    passed: 0,
    failed: 0,
    needsReview: 0,
    readFailed: 0,
    topicMissing: 0,
    clickableAbnormal: 0,
  };
  for (const group of groups) {
    const count = group._count._all;
    counts.total += count;
    if (group.autoStatus === "PASSED") counts.passed += count;
    if (group.autoStatus === "FAILED") counts.failed += count;
    if (group.autoStatus === "NEEDS_REVIEW") counts.needsReview += count;
    if (group.autoStatus === "READ_FAILED") counts.readFailed += count;
    if (!group.topicsCompliant) counts.topicMissing += count;
    if (!group.clickableCompliant) counts.clickableAbnormal += count;
  }
  return counts;
}

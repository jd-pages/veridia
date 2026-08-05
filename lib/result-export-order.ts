export interface ImportOrderedAuditResult {
  id: string;
  createdAt: Date;
  task: {
    batchId: string | null;
    queueOrder: number;
    createdAt: Date;
    batch?: { createdAt: Date } | null;
  };
}

export function sortAuditResultsByImportOrder<
  T extends ImportOrderedAuditResult,
>(rows: readonly T[]) {
  return [...rows].sort((left, right) => {
    const leftGroup = left.task.batch?.createdAt || left.task.createdAt;
    const rightGroup = right.task.batch?.createdAt || right.task.createdAt;
    const groupDifference = leftGroup.getTime() - rightGroup.getTime();
    if (groupDifference) return groupDifference;

    if (left.task.batchId === right.task.batchId) {
      const rowDifference = left.task.queueOrder - right.task.queueOrder;
      if (rowDifference) return rowDifference;
    }

    const taskDifference =
      left.task.createdAt.getTime() - right.task.createdAt.getTime();
    if (taskDifference) return taskDifference;
    const resultDifference = left.createdAt.getTime() - right.createdAt.getTime();
    return resultDifference || left.id.localeCompare(right.id);
  });
}

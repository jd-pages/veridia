export interface ImportOrderedAuditResult {
  id: string;
  createdAt: Date;
  resultSlotOrder?: number;
  resultSlotCreatedAt?: Date | null;
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
    const leftGroup =
      left.resultSlotCreatedAt || left.task.batch?.createdAt || left.task.createdAt;
    const rightGroup =
      right.resultSlotCreatedAt || right.task.batch?.createdAt || right.task.createdAt;
    const groupDifference = leftGroup.getTime() - rightGroup.getTime();
    if (groupDifference) return groupDifference;

    const rowDifference =
      (left.resultSlotOrder ?? left.task.queueOrder) -
      (right.resultSlotOrder ?? right.task.queueOrder);
    if (rowDifference) return rowDifference;

    const taskDifference =
      left.task.createdAt.getTime() - right.task.createdAt.getTime();
    if (taskDifference) return taskDifference;
    const resultDifference = left.createdAt.getTime() - right.createdAt.getTime();
    return resultDifference || left.id.localeCompare(right.id);
  });
}

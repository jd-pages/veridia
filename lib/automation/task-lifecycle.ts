export function completedAuditTaskUpdate(finishedAt = new Date()) {
  return {
    status: "COMPLETED" as const,
    finishedAt,
  };
}

export function completedAuditBatchUpdate(
  hasErrors: boolean,
  finishedAt = new Date(),
) {
  return {
    status: hasErrors ? ("COMPLETED_WITH_ERRORS" as const) : ("COMPLETED" as const),
    currentTaskId: null,
    finishedAt,
  };
}

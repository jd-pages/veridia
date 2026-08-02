export function pageAfterResultDeletion(input: {
  total: number;
  page: number;
  pageSize: number;
  deletedCount: number;
}) {
  const remaining = Math.max(input.total - input.deletedCount, 0);
  const lastPage = Math.max(Math.ceil(remaining / input.pageSize), 1);
  return Math.min(input.page, lastPage);
}

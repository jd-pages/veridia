export function isDatabaseSchemaMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "P2021" || candidate.code === "P2022") return true;
  if (
    typeof candidate.message === "string" &&
    /(normalizedUsername|no such column|does not exist in the current database)/iu.test(
      candidate.message,
    )
  ) {
    return true;
  }
  return candidate.cause
    ? isDatabaseSchemaMismatch(candidate.cause)
    : false;
}

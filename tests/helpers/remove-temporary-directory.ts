import { rm } from "node:fs/promises";

const WINDOWS_RELEASE_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;
const RETRYABLE_WINDOWS_REMOVE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function removeTemporaryDirectoryWithRetry(directory: string) {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= WINDOWS_RELEASE_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      const retryDelay = WINDOWS_RELEASE_RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE_WINDOWS_REMOVE_CODES.has(code) || retryDelay === undefined) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
  throw lastError;
}

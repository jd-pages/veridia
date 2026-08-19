import { AutomaticExtractionError } from "./failure";

export const DEFAULT_AUTOMATION_EXTRACTION_DEADLINE_MS = 120_000;

export function automationExtractionDeadlineMs() {
  const configured = Number(
    process.env.AUTOMATION_EXTRACTION_DEADLINE_MS ||
      DEFAULT_AUTOMATION_EXTRACTION_DEADLINE_MS,
  );
  return Number.isFinite(configured) ? Math.max(100, configured) : 120_000;
}

export async function runWithExtractionDeadline<T>(input: {
  operation: Promise<T>;
  cancel: () => Promise<void>;
  deadlineMs?: number;
  batchId: string;
  taskId: string;
  runEpoch: number;
}) {
  const deadlineMs = input.deadlineMs ?? automationExtractionDeadlineMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        console.warn(
          "[自动审核生命周期] EXTRACTION_DEADLINE_EXCEEDED",
          JSON.stringify({
            batchId: input.batchId,
            taskId: input.taskId,
            runEpoch: input.runEpoch,
            deadlineMs,
          }),
        );
        await input.cancel().catch(() => undefined);
        reject(
          new AutomaticExtractionError(
            "LOAD_TIMEOUT",
            `自动提取超过 ${deadlineMs}ms 确定性上限，已取消本次浏览器操作`,
          ),
        );
      })();
    }, deadlineMs);
  });
  try {
    return await Promise.race([input.operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

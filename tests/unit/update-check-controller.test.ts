import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

type UpdateStatus = {
  state: string;
  message?: string;
  errorType?: string;
  timedOut?: boolean;
};

type UpdateCheckController = {
  checkForUpdates(manual?: boolean): Promise<unknown>;
  isChecking(): boolean;
  isManual(): boolean;
};

type CreateUpdateCheckController = (options: {
  check(): Promise<unknown>;
  currentVersion(): string;
  sendStatus(status: UpdateStatus): void;
  onResult(result: unknown, manual: boolean): void;
  writeDiagnostic(details: Record<string, unknown>): void;
  timeoutMs?: number;
  now?: () => number;
}) => UpdateCheckController;

const require = createRequire(import.meta.url);
const {
  UPDATE_CHECK_TIMEOUT_MESSAGE,
  createUpdateCheckController,
} = require("../../desktop/update-check.cjs") as {
  UPDATE_CHECK_TIMEOUT_MESSAGE: string;
  createUpdateCheckController: CreateUpdateCheckController;
};

function fixture(check: () => Promise<unknown>, timeoutMs = 30_000) {
  const statuses: UpdateStatus[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  const onResult = vi.fn();
  const controller = createUpdateCheckController({
    check,
    currentVersion: () => "1.1.3",
    sendStatus: (status) => statuses.push(status),
    onResult,
    writeDiagnostic: (details) => diagnostics.push(details),
    timeoutMs,
  });
  return { controller, diagnostics, onResult, statuses };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("桌面端检查更新超时控制", () => {
  it("正常发现新版并释放检查锁", async () => {
    const result = {
      isUpdateAvailable: true,
      updateInfo: { version: "1.1.4" },
    };
    const { controller, diagnostics, onResult, statuses } = fixture(() =>
      Promise.resolve(result),
    );

    await expect(controller.checkForUpdates(true)).resolves.toBe(result);

    expect(statuses[0]).toMatchObject({ state: "checking" });
    expect(onResult).toHaveBeenCalledWith(result, true);
    expect(diagnostics.at(-1)).toMatchObject({
      outcome: "UPDATE_AVAILABLE",
      timedOut: false,
    });
    expect(controller.isChecking()).toBe(false);
    expect(controller.isManual()).toBe(false);
  });

  it("当前已是最新版并释放检查锁", async () => {
    const result = {
      isUpdateAvailable: false,
      updateInfo: { version: "1.1.3" },
    };
    const { controller, diagnostics, onResult } = fixture(() =>
      Promise.resolve(result),
    );

    await controller.checkForUpdates(true);

    expect(onResult).toHaveBeenCalledWith(result, true);
    expect(diagnostics.at(-1)).toMatchObject({
      outcome: "UP_TO_DATE",
      currentVersion: "1.1.3",
      errorType: null,
    });
    expect(controller.isChecking()).toBe(false);
  });

  it("GitHub 返回错误时记录错误类型并停止 checking", async () => {
    const error = Object.assign(new Error("GitHub release request failed"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    const { controller, diagnostics, statuses } = fixture(() =>
      Promise.reject(error),
    );

    await expect(controller.checkForUpdates(true)).resolves.toBeNull();

    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      errorType: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      timedOut: false,
    });
    expect(diagnostics.at(-1)).toMatchObject({
      outcome: "ERROR",
      timedOut: false,
    });
    expect(controller.isChecking()).toBe(false);
  });

  it("自动检查请求永久挂起时30秒超时并清理检查状态", async () => {
    vi.useFakeTimers();
    const { controller, diagnostics, statuses } = fixture(
      () => new Promise(() => undefined),
    );

    const pending = controller.checkForUpdates(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBeNull();

    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      message: UPDATE_CHECK_TIMEOUT_MESSAGE,
      errorType: "TIMEOUT",
      timedOut: true,
    });
    expect(diagnostics.at(-1)).toMatchObject({
      errorType: "TIMEOUT",
      timedOut: true,
    });
    expect(controller.isChecking()).toBe(false);
    expect(controller.isManual()).toBe(false);
  });

  it("超时后允许再次点击检查且不会复用已清理的应用锁", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const { controller, onResult } = fixture(() => {
      attempt += 1;
      return attempt === 1
        ? new Promise(() => undefined)
        : Promise.resolve({
            isUpdateAvailable: false,
            updateInfo: { version: "1.1.3" },
          });
    });

    const first = controller.checkForUpdates(false);
    const duplicate = controller.checkForUpdates(true);
    expect(duplicate).toBe(first);
    expect(controller.isManual()).toBe(true);
    expect(attempt).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    expect(controller.isChecking()).toBe(false);

    await controller.checkForUpdates(true);
    expect(attempt).toBe(2);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(controller.isChecking()).toBe(false);
  });
});

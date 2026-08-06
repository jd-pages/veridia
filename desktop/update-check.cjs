const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_CHECK_TIMEOUT_MESSAGE = "检查更新超时，请检查网络或稍后重试。";

class UpdateCheckTimeoutError extends Error {
  constructor() {
    super(UPDATE_CHECK_TIMEOUT_MESSAGE);
    this.name = "UpdateCheckTimeoutError";
    this.code = "UPDATE_CHECK_TIMEOUT";
  }
}

function updateErrorType(error) {
  if (error instanceof UpdateCheckTimeoutError) return "TIMEOUT";
  if (typeof error?.code === "string" && error.code.trim()) {
    return error.code.trim().slice(0, 80);
  }
  if (typeof error?.name === "string" && error.name.trim()) {
    return error.name.trim().slice(0, 80);
  }
  return "UNKNOWN_ERROR";
}

function createUpdateCheckController({
  check,
  currentVersion,
  sendStatus,
  onResult,
  writeDiagnostic,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let updateCheckPromise;
  let manualUpdateCheck = false;

  function isChecking() {
    return Boolean(updateCheckPromise);
  }

  function isManual() {
    return manualUpdateCheck;
  }

  function checkForUpdates(manual = false) {
    if (updateCheckPromise) {
      if (manual) manualUpdateCheck = true;
      return updateCheckPromise;
    }

    manualUpdateCheck = Boolean(manual);
    const startedAt = now();
    const version = currentVersion();
    let timeoutHandle;

    writeDiagnostic({
      event: "UPDATE_CHECK_STARTED",
      startedAt: new Date(startedAt).toISOString(),
      currentVersion: version,
      manual: manualUpdateCheck,
    });
    sendStatus({ state: "checking", manual: manualUpdateCheck });

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimer(
        () => reject(new UpdateCheckTimeoutError()),
        timeoutMs,
      );
    });

    updateCheckPromise = Promise.race([
      Promise.resolve().then(() => check()),
      timeoutPromise,
    ])
      .then((result) => {
        const durationMs = Math.max(0, now() - startedAt);
        writeDiagnostic({
          event: "UPDATE_CHECK_FINISHED",
          startedAt: new Date(startedAt).toISOString(),
          currentVersion: version,
          durationMs,
          outcome: result?.isUpdateAvailable ? "UPDATE_AVAILABLE" : "UP_TO_DATE",
          errorType: null,
          timedOut: false,
        });
        onResult(result, manualUpdateCheck);
        return result;
      })
      .catch((error) => {
        const timedOut = error instanceof UpdateCheckTimeoutError;
        const errorType = updateErrorType(error);
        const durationMs = Math.max(0, now() - startedAt);
        writeDiagnostic({
          event: "UPDATE_CHECK_FINISHED",
          startedAt: new Date(startedAt).toISOString(),
          currentVersion: version,
          durationMs,
          outcome: "ERROR",
          errorType,
          timedOut,
        });
        sendStatus({
          state: "error",
          message: timedOut
            ? UPDATE_CHECK_TIMEOUT_MESSAGE
            : error instanceof Error
              ? error.message
              : "检查更新失败",
          manual: manualUpdateCheck,
          errorType,
          timedOut,
        });
        return null;
      })
      .finally(() => {
        if (timeoutHandle !== undefined) clearTimer(timeoutHandle);
        manualUpdateCheck = false;
        updateCheckPromise = undefined;
      });

    return updateCheckPromise;
  }

  return {
    checkForUpdates,
    isChecking,
    isManual,
  };
}

module.exports = {
  UPDATE_CHECK_TIMEOUT_MESSAGE,
  UPDATE_CHECK_TIMEOUT_MS,
  UpdateCheckTimeoutError,
  createUpdateCheckController,
  updateErrorType,
};

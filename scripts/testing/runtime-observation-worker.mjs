import { parentPort, workerData, threadId } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createPersistentRuntimeProvider } from "./runtime-observation-provider-client.mjs";

// Exported host seam permits pure fake-provider tests without launching threads.
export function startRuntimeObservationWorker({ parent, data, workerThreadId = threadId,
  createProvider = createPersistentRuntimeProvider, now = () => performance.now(), timeOrigin = performance.timeOrigin }) {
  const { runId, observerId, port, wrapperPid, wrapperIdentity, startupDeadlineMs } = data || {};
  if (!parent || !/^[A-Za-z0-9_.-]{1,256}$/u.test(runId || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(observerId || "") ||
    wrapperPid !== process.pid || wrapperIdentity?.pid !== wrapperPid ||
    !Number.isSafeInteger(port) || port < 1 || port > 65535 || data.timeOrigin !== timeOrigin ||
    !Number.isFinite(startupDeadlineMs) || startupDeadlineMs <= now()) throw new Error("E2E observation worker data invalid");
  const identity = { runId, observerId, port, wrapperPid, workerThreadId, timeOrigin };
  const provider = createProvider({ runId, observerId, port, wrapperIdentity, startupDeadlineMs });
  let sequence = 0, pending, stopPromise, failure;
  const providerReceipt = () => {
    const snapshot = provider.snapshot();
    return { ...snapshot, receipts: snapshot.receipts.filter(row => !["QUERY_SENT", "QUERY_RESULT_VALIDATED"].includes(row.event)) };
  };
  const fail = code => { failure ??= code; parent.postMessage({ ...identity, event: "FAILED", error: failure, nativeProviderJoin: providerReceipt() }); };
  provider.ready.then(() => {
    if (stopPromise || failure) return;
    parent.postMessage({ ...identity, event: "READY", readyMs: now(), nativeProviderIdentity: providerReceipt() });
  }, () => fail("E2E observation native provider startup failed"));
  parent.on("message", message => {
    try {
      if (message.runId !== runId || message.observerId !== observerId) throw new Error("E2E observation worker command identity invalid");
      if (message.command === "STOP") {
        if (stopPromise || message.sequence !== sequence || !Number.isFinite(message.deadlineMs)) throw new Error("E2E observation worker STOP invalid");
        // Caller phase deadline is mandatory; native provider never gets >15s.
        const deadlineMs = Math.min(message.deadlineMs, now() + 15_000);
        stopPromise = (async () => {
          try {
            await provider.stop(deadlineMs);
            if (pending) await pending;
            const nativeProviderJoin = providerReceipt();
            if (failure || nativeProviderJoin.status !== "PASSED" || nativeProviderJoin.joined !== true) throw new Error("E2E observation native provider join failed");
            parent.postMessage({ ...identity, event: "STOP_ACK", sequence, acknowledgedMs: now(), nativeProviderJoin });
            parent.close();
          } catch {
            fail("E2E observation native provider stop failed");
            // Do not close/terminate an unjoined provider or pretend its worker
            // has safely ended. A later actual close can publish failed exit.
            if (provider.snapshot().joined === true) parent.close();
            else provider.closed.then(() => {
              fail("E2E observation native provider late failed join");
              if (provider.snapshot().joined === true) parent.close();
            });
          }
        })();
        return;
      }
      if (failure || stopPromise || pending || message.command !== "QUERY" || message.port !== port || message.wrapperPid !== wrapperPid ||
        message.timeOrigin !== timeOrigin || message.sequence !== sequence + 1 ||
        !Number.isFinite(message.sentMs) || message.deadlineMs !== message.sentMs + 15_000) throw new Error("E2E observation worker query invalid");
      sequence = message.sequence;
      const queryStartedMs = now(), queryStartedAt = new Date().toISOString();
      pending = (async () => {
        let runtime = null, error = null;
        try {
          runtime = await provider.query({ deadlineMs: message.deadlineMs });
          if (now() >= message.deadlineMs) throw new Error("E2E observation native actual query deadline exhausted");
        } catch { error = "E2E observation native provider query failed"; }
        parent.postMessage({ ...identity, event: "QUERY_RESULT", sequence: message.sequence,
          provider: "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE", queryStartedMs, queryEndedMs: now(),
          queryStartedAt, queryEndedAt: new Date().toISOString(), runtime, error,
          ...(error ? { nativeProviderFailure: providerReceipt() } : {}) });
      })().finally(() => { pending = undefined; });
    } catch (error) { fail(error.message); }
  });
  return { provider, snapshot: () => ({ sequence, stopping: !!stopPromise, failure: failure ?? null }) };
}

if (parentPort) startRuntimeObservationWorker({ parent: parentPort, data: workerData });

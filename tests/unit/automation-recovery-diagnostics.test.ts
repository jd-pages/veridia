import { afterEach, expect, it, vi } from "vitest";
import { getRecoveryDiagnostics, recordBrowserControlPause, recordNativeProfileProbe } from "@/lib/automation/recovery-diagnostics";

afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as { veridiaRecoveryDiagnostics?: unknown }).veridiaRecoveryDiagnostics; });

it("production cannot store or expose E2E recovery receipts", () => {
  vi.stubEnv("VERIDIA_E2E", "false");
  recordNativeProfileProbe({ probeId: "production-no-op" });
  recordBrowserControlPause({ phase: "production-no-op" });
  expect(getRecoveryDiagnostics()).toBeUndefined();
  expect((globalThis as { veridiaRecoveryDiagnostics?: unknown }).veridiaRecoveryDiagnostics).toBeUndefined();
});

it("correlates a completed failing native probe and the first pause trigger by probeId and ordered same-process events", () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  recordNativeProfileProbe({ probeId: "probe-A", status: "FAILED", reason: "NATIVE_PROBE_DEADLINE", probeProcessId: 23, probeBirthStamp: "134000000000000001" });
  recordBrowserControlPause({ phase: "PAUSE_TRIGGER", batchId: "batch-A", ownerGeneration: 5, browserControlDiagnostic: { nativeProbe: { probeId: "probe-A" } } });
  recordBrowserControlPause({ phase: "PAUSE_COMMITTED", batchId: "batch-A", affectedBatchCount: 1 });
  const history = getRecoveryDiagnostics()!;
  expect(history.nativeProbes[0]).toMatchObject({ sequence: 1, probeId: "probe-A", probeProcessId: 23, probeBirthStamp: "134000000000000001" });
  expect(history.pauses[0]).toMatchObject({ sequence: 2, browserControlDiagnostic: { nativeProbe: { probeId: "probe-A" } } });
  expect(history.pauses[1]).toMatchObject({ sequence: 3, affectedBatchCount: 1 });
});

it("bounds histories without synthesizing missing native identities or granting cleanup authority", () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  for (let index = 0; index < 60; index++) recordNativeProfileProbe({ probeId: `probe-${index}`, status: "FAILED" });
  const history = getRecoveryDiagnostics()!;
  expect(history.nativeProbes).toHaveLength(48);
  expect(history.nativeProbes[0]).toMatchObject({ sequence: 13, probeId: "probe-12" });
  expect(history.nativeProbes.at(-1)).not.toHaveProperty("probeBirthStamp");
  expect(history.nativeProbes.at(-1)).not.toHaveProperty("owners");
});

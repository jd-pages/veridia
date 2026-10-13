// Isolated E2E observability only. None of these receipts grant ownership,
// change a deadline, retry an operation or write business/database state.
const state = globalThis as typeof globalThis & {
  veridiaRecoveryDiagnostics?: { sequence: number; nativeProbes: Record<string, unknown>[]; pauses: Record<string, unknown>[] };
};

function append(kind: "nativeProbes" | "pauses", details: Record<string, unknown>) {
  if (process.env.VERIDIA_E2E !== "true") return;
  const history = state.veridiaRecoveryDiagnostics ??= { sequence: 0, nativeProbes: [], pauses: [] };
  const entry = { sequence: ++history.sequence, observedAt: new Date().toISOString(), ...details };
  history[kind].push(entry);
  if (history[kind].length > 48) history[kind].splice(0, history[kind].length - 48);
}

export function recordNativeProfileProbe(details: Record<string, unknown>) { append("nativeProbes", details); }
export function recordBrowserControlPause(details: Record<string, unknown>) { append("pauses", details); }
export function getRecoveryDiagnostics() {
  if (process.env.VERIDIA_E2E !== "true") return undefined;
  return state.veridiaRecoveryDiagnostics ?? { sequence: 0, nativeProbes: [], pauses: [] };
}

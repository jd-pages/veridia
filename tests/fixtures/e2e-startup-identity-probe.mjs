import path from "node:path";
import { spawn } from "node:child_process";
import { captureInitialOwnedRoot, closeRejectedCreatorChild, E2eInitialIdentityError } from "../../scripts/testing/e2e-startup-identity.mjs";
import { captureWindowsRuntime } from "../../scripts/testing/e2e-server-infrastructure.mjs";
const started = performance.now();
const child = spawn(process.execPath, [path.resolve("tests/fixtures/e2e-startup-identity-child.cjs")],
  { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.on("error", () => {});
try {
  const result = captureInitialOwnedRoot(child, { parentPid: process.pid, name: path.basename(process.execPath),
    commandIdentity: "SYNTHETIC_IDLE_NODE_NO_DB", capture: budget => captureWindowsRuntime(65431, undefined, budget) });
  // Fault injection into the census, NOT a foreign process. It must reject the
  // parent mismatch even when the real creator-held handle is still alive.
  let failure;
  const failureStarted = performance.now();
  try { captureInitialOwnedRoot(child, { parentPid: process.pid, name: path.basename(process.execPath), commandIdentity: "SYNTHETIC_WRONG_PARENT",
    capture: () => ({ ...result.runtime, processes: result.runtime.processes.map(row => row.pid === child.pid ? { ...row, parentPid: process.pid + 1 } : row) }) }); }
  catch (error) { if (!(error instanceof E2eInitialIdentityError)) throw error; failure = error.evidence; }
  if (!failure || failure.status !== "FAILED") throw new Error("PARENT_MISMATCH_NOT_REJECTED");
  const close = await closeRejectedCreatorChild(child);
  const failureDurationMs = performance.now() - failureStarted;
  if (close.closeObserved !== true || failureDurationMs > 30000) throw new Error("REJECTED_CREATOR_CLOSE_NOT_BOUNDED");
  console.log(JSON.stringify({ label: "E2E_SERVER_INITIAL_PROCESS_IDENTITY_PROBE", node: process.version, status: "PASS", initial: result.evidence,
    injectedFailure: failure, failureDurationMs, close, elapsedMs: performance.now() - started }));
} catch (error) {
  const close = await closeRejectedCreatorChild(child);
  console.log(JSON.stringify({ label: "E2E_SERVER_INITIAL_PROCESS_IDENTITY_PROBE", status: "FAILED", evidence: error.evidence ?? null, close,
    errorName: error.name, elapsedMs: performance.now() - started }));
  process.exitCode = 1;
}

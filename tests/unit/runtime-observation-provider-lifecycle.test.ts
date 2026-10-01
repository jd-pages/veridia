import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { startRuntimeObservationWorker } from "../../scripts/testing/runtime-observation-worker.mjs";
import type { ProviderObservation, PersistentRuntimeProvider } from "../../scripts/testing/runtime-observation-provider-client.mjs";

const observerId = "22222222-2222-4222-8222-222222222222";
class Parent extends EventEmitter {
  messages: Record<string, unknown>[] = [];
  closed = 0;
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  close() { this.closed++; }
}
function fixture() {
  const parent = new Parent();
  let resolveReady!: (value: ProviderObservation) => void, rejectReady!: (error: Error) => void;
  let resolveStop!: (value: ProviderObservation) => void, rejectStop!: (error: Error) => void, resolveClosed!: () => void;
  const ready = new Promise<ProviderObservation>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const stopped = new Promise<ProviderObservation>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const observation: ProviderObservation = { status: "NOT_COMPLETE", state: "RUNNING", firstFailure: null,
    runId: "pure-host", observerId, port: 3100, wrapperPid: process.pid, wrapperCreatedAt: "2026-10-01T00:00:00.0000000Z",
    providerPid: 200, providerParentPid: process.pid, providerNativeBirthStamp: "134037504010000000", providerCreatedAt: "2026-10-01T00:00:01.0000000Z",
    wrapperNativeBirthStamp: String(BigInt(Date.parse("2026-10-01T00:00:00.0000000Z")) * 10000n + 116444736000000000n),
    startedMs: 100, startupDeadlineMs: 15100, stopDeadlineMs: null, sequence: 0, inFlightSequence: null,
    eofSent: false, eofAcknowledged: false, stdoutEnded: false, exitObserved: false, closeObserved: false,
    exitCode: null, closeCode: null, joined: false, stderrBytes: 0, receipts: [] };
  const stopCalls: number[] = [];
  const provider: PersistentRuntimeProvider = { ready, closed, snapshot: () => observation,
    query: () => Promise.reject(new Error("No native query in host lifecycle fixture")),
    stop: deadline => { stopCalls.push(deadline); return stopped; } };
  const host = startRuntimeObservationWorker({ parent, workerThreadId: 7, now: () => 100, timeOrigin: 123,
    data: { runId: "pure-host", observerId, port: 3100, wrapperPid: process.pid,
      wrapperIdentity: { pid: process.pid, createdAt: observation.wrapperCreatedAt }, startupDeadlineMs: 15100, timeOrigin: 123 },
    createProvider: () => provider });
  const command = (extra: Record<string, unknown> = {}) => parent.emit("message", { command: "STOP", runId: "pure-host", observerId,
    sequence: 0, deadlineMs: 1000, ...extra });
  const complete = () => { Object.assign(observation, { status: "PASSED", state: "STOPPED", joined: true, eofSent: true,
    eofAcknowledged: true, stdoutEnded: true, exitObserved: true, closeObserved: true, exitCode: 0, closeCode: 0 });
    resolveStop(observation); resolveClosed(); };
  return { parent, host, observation, stopCalls, command, complete, resolveReady, rejectReady, rejectStop, resolveClosed };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("native provider worker bridge, pure fake provider only", () => {
  it("never ACKs STOP before actual native provider natural join", async () => {
    const f = fixture(); f.resolveReady(f.observation); await flush(); f.command(); await flush();
    expect(f.parent.messages.some(row => row.event === "STOP_ACK")).toBe(false); expect(f.parent.closed).toBe(0);
    f.complete(); await flush();
    expect(f.parent.messages.find(row => row.event === "STOP_ACK")?.nativeProviderJoin).toMatchObject({ joined: true, eofAcknowledged: true, exitCode: 0 });
    expect(f.parent.closed).toBe(1);
  });
  it("caps provider shutdown at 15s while preserving a tighter caller deadline", async () => {
    const f = fixture(); f.resolveReady(f.observation); await flush(); f.command({ deadlineMs: 45100 });
    expect(f.stopCalls).toEqual([15100]); f.complete(); await flush();
    const g = fixture(); g.resolveReady(g.observation); await flush(); g.command({ deadlineMs: 500 });
    expect(g.stopCalls).toEqual([500]); g.complete(); await flush();
  });
  it("startup failure retains owned provider and closes only after actual joined cleanup", async () => {
    const f = fixture(); f.rejectReady(new Error("synthetic failure")); await flush(); f.command();
    expect(f.parent.messages[0].event).toBe("FAILED"); expect(f.parent.closed).toBe(0);
    f.complete(); await flush();
    expect(f.parent.messages.some(row => row.event === "STOP_ACK")).toBe(false); expect(f.parent.closed).toBe(1);
  });
  it("late failed provider join remains FAILED and never creates a successful STOP ACK", async () => {
    const f = fixture(); f.resolveReady(f.observation); await flush(); f.command();
    f.observation.status = "FAILED"; f.observation.firstFailure = "PROVIDER_STOP_DEADLINE_EXHAUSTED";
    f.rejectStop(new Error("synthetic exhausted deadline")); await flush(); expect(f.parent.closed).toBe(0);
    f.observation.joined = true; f.resolveClosed(); await flush();
    expect(f.parent.messages.some(row => row.event === "STOP_ACK")).toBe(false); expect(f.parent.closed).toBe(1);
    expect(f.parent.messages.at(-1)?.nativeProviderJoin).toMatchObject({ status: "FAILED", joined: true });
  });
});

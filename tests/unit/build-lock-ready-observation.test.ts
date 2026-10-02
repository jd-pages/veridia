import { describe, expect, test } from "vitest";
import { createBuildLockReadyObservation, projectBuildLockReadyStartupFailure } from "../../scripts/testing/build-lock-diagnostics.mjs";
const context = { invocationId: "11111111-1111-4111-8111-111111111111", nonce: "22222222-2222-4222-8222-222222222222",
  supportIdentity: "a".repeat(64), role: "Supervisor", pid: 101, now: () => 25 };
const notice = (change = {}) => `VERIDIA_NATIVE_READY_STAGE=${JSON.stringify({ ...context, now: undefined,
  role: "Supervisor", pid: 101, stage: "ADD_TYPE_START", utc: "2026-10-02T00:00:00.0000000Z", qpcTicks: "123", qpcFrequency: "10000000", ...change })}\n`;
describe("bounded private native READY observation (never READY or ownership authority)", () => {
  test("accepts split fixed notices and excludes arbitrary private fields", () => {
    const observer = createBuildLockReadyObservation(context), line = notice({ secret: "DO_NOT_EXPORT", rawEnvironment: { credential: "DO_NOT_EXPORT" } });
    observer.push(line.slice(0, 20)); expect(observer.snapshot().records).toEqual([]); observer.push(line.slice(20));
    expect(observer.snapshot().records).toEqual([{ role: "Supervisor", pid: 101, stage: "ADD_TYPE_START", utc: "2026-10-02T00:00:00.0000000Z",
      qpcTicks: "123", qpcFrequency: "10000000", observedMonoMs: 25, authority: "OWNED_STDOUT_NOTICE_NOT_NATIVE_IDENTITY_OR_READY_PROOF" }]);
    expect(JSON.stringify(observer.snapshot())).not.toContain("DO_NOT_EXPORT");
  });
  test.each([{ nonce: "foreign" }, { supportIdentity: "foreign" }, { role: "Guardian" }, { pid: 102 },
    { stage: "IMAGINARY_READY" }, { utc: "invalid" }, { qpcTicks: null }, { qpcFrequency: "0" }])("ignores foreign or malformed notice %j without retaining payload", change => {
    const observer = createBuildLockReadyObservation(context); observer.push(notice(change)); expect(observer.snapshot().records).toEqual([]);
  });
  test("worker notices can only be transported by the owned Supervisor pipe", () => {
    const supervisor = createBuildLockReadyObservation(context); supervisor.push(notice({ role: "Worker", pid: 102, stage: "FIRST_RM_START" }));
    expect(supervisor.snapshot().records[0]).toMatchObject({ role: "Worker", pid: 102, authority: "OWNED_STDOUT_NOTICE_NOT_NATIVE_IDENTITY_OR_READY_PROOF" });
    const guardian = createBuildLockReadyObservation({ ...context, role: "Guardian" }); guardian.push(notice({ role: "Worker", pid: 102 }));
    expect(guardian.snapshot().records).toEqual([]);
  });
  test("unparsed text and missing milestones remain unmeasured, never fake native zero", () => {
    const observer = createBuildLockReadyObservation(context); observer.push("credentials=DO_NOT_EXPORT\nnot JSON\n");
    expect(observer.snapshot()).toEqual({ measurement: "OWNED_STDOUT_STAGE_NOTICES", truncated: false, records: [] });
  });
  test.each(["null", "[]", "true", "42", "\"private\""])("primitive JSON notice cannot throw or fabricate a stage: %s", value => {
    const observer = createBuildLockReadyObservation(context);
    expect(() => observer.push(`VERIDIA_NATIVE_READY_STAGE=${value}\n`)).not.toThrow(); expect(observer.snapshot().records).toEqual([]);
  });
  test("observation clock failure cannot replace the primary native lifecycle failure", () => {
    const observer = createBuildLockReadyObservation({ ...context, now: () => { throw new Error("private clock error"); } });
    expect(() => observer.push(notice())).not.toThrow(); expect(observer.snapshot()).toMatchObject({ truncated: true, records: [] });
  });
  test("receipt startup projection rejects arbitrary payloads and preserves missing measurements", () => {
    expect(projectBuildLockReadyStartupFailure({ secret: "DO_NOT_EXPORT" })).toEqual({ measurement: "NOT_MEASURED", observedAt: null,
      elapsedMs: null, readyBudgetMs: null, members: null, supervisor: null, guardian: null });
    const observer = createBuildLockReadyObservation(context); observer.push(notice());
    const value = { measurement: "PRE_TEARDOWN_OBSERVATION_NOT_CAUSAL_ATTRIBUTION", observedAt: "2026-10-02T00:00:01.000Z",
      elapsedMs: 15000, readyBudgetMs: 15000,
      members: ["supervisor-created.json", "worker-created.json", "guardian-armed.json", "worker-ready.json"].map(name => ({ name, present: false, secret: "DO_NOT_EXPORT" })),
      supervisor: { ...observer.snapshot(), secret: "DO_NOT_EXPORT" }, guardian: null, secret: "DO_NOT_EXPORT" };
    const projected = projectBuildLockReadyStartupFailure(value);
    expect(projected).toMatchObject({ elapsedMs: 15000, readyBudgetMs: 15000, guardian: null });
    expect(JSON.stringify(projected)).not.toContain("DO_NOT_EXPORT");
    expect(projectBuildLockReadyStartupFailure({ ...value, members: [] })).toMatchObject({ measurement: "NOT_MEASURED", members: null });
  });
  test("record and unterminated-line caps cannot retain unbounded payload", () => {
    const observer = createBuildLockReadyObservation(context); for (let i = 0; i < 33; i++) observer.push(notice());
    expect(observer.snapshot().records).toHaveLength(32); expect(observer.snapshot().truncated).toBe(true);
    const oversized = createBuildLockReadyObservation(context); oversized.push("private".repeat(1000)); oversized.push(notice());
    expect(oversized.snapshot()).toMatchObject({ truncated: true, records: [] });
  });
  test("snapshots cannot mutate subsequent observations", () => {
    const observer = createBuildLockReadyObservation(context); observer.push(notice()); observer.snapshot().records[0].stage = "mutated";
    expect(observer.snapshot().records[0].stage).toBe("ADD_TYPE_START");
  });
});

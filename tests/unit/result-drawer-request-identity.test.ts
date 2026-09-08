import { describe, expect, it } from "vitest";
import {
  ownsSelectedResultDrawerRequest,
  ResultDrawerRequestIdentity,
} from "@/lib/result-drawer-request-identity";

describe("RESULT_DRAWER_RESPONSE_IDENTITY", () => {
  it("正常打开 A 时仅接受 A 的详情 payload", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    expect(ownsSelectedResultDrawerRequest(identity, a, "A")).toBe(true);
    expect(identity.accepts(a, "A")).toBe(true);
    expect(identity.accepts(a, "B")).toBe(false);
  });

  it("A→B 会中止 A，并以 generation 与 selected result 双重拒绝迟到 A", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    const b = identity.begin("B");
    expect(a.signal.aborted).toBe(true);
    expect(ownsSelectedResultDrawerRequest(identity, a, "B")).toBe(false);
    expect(ownsSelectedResultDrawerRequest(identity, b, "B")).toBe(true);
  });

  it("关闭 drawer 会使 pending request generation 失效", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    identity.invalidate();
    expect(a.signal.aborted).toBe(true);
    expect(ownsSelectedResultDrawerRequest(identity, a, null)).toBe(false);
  });

  it("close → reopen B 后不能重新接受关闭前的 A", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    identity.invalidate();
    const b = identity.begin("B");
    expect(ownsSelectedResultDrawerRequest(identity, a, "B")).toBe(false);
    expect(identity.accepts(a, "A")).toBe(false);
    expect(identity.accepts(b, "B")).toBe(true);
  });

  it("A→B→C 任意旧代次均无权更新 C", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    const b = identity.begin("B");
    const c = identity.begin("C");
    expect(ownsSelectedResultDrawerRequest(identity, a, "C")).toBe(false);
    expect(ownsSelectedResultDrawerRequest(identity, b, "C")).toBe(false);
    expect(ownsSelectedResultDrawerRequest(identity, c, "C")).toBe(true);
  });

  it("stale success、stale failure 与 finally 都不拥有新请求的 loading", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    const b = identity.begin("B");
    for (const phase of ["success", "failure", "finally"]) {
      expect(
        ownsSelectedResultDrawerRequest(identity, a, "B"),
        phase,
      ).toBe(false);
    }
    expect(ownsSelectedResultDrawerRequest(identity, b, "B")).toBe(true);
  });

  it("当前请求失败时旧 detail 不具备当前请求身份", () => {
    const identity = new ResultDrawerRequestIdentity();
    const a = identity.begin("A");
    const b = identity.begin("B");
    expect(identity.accepts(a, "A")).toBe(false);
    expect(ownsSelectedResultDrawerRequest(identity, b, "B")).toBe(true);
  });

  it("payload result ID mismatch 即使 generation 当前也不能被接受", () => {
    const identity = new ResultDrawerRequestIdentity();
    const current = identity.begin("A");
    expect(identity.accepts(current, "B")).toBe(false);
    expect(identity.accepts(current, "A")).toBe(true);
  });
});

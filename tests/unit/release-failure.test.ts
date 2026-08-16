import { describe, expect, it } from "vitest";

import {
  classifyReleaseFailure,
  inferVerifyFailure,
  parseReleaseResult,
  releaseResultLine,
  ReleaseStageError,
} from "../../scripts/release-failure.mjs";

describe("Release stage error propagation", () => {
  it("Unit timeout is TEST_TIMEOUT and preserves the failed test", () => {
    const output = [
      "FAIL tests/unit/playwright-chromium-runtime.test.ts > Case C",
      "Error: Test timed out in 5000ms.",
      'VERIDIA_VERIFY_RESULT={"passed":false,"failures":["All unit tests"]}',
    ].join("\n");

    const error = inferVerifyFailure(output, "E:\\logs\\full.log");

    expect(error).toMatchObject({
      stage: "UNIT_TEST",
      classification: "TEST_TIMEOUT",
      detailLog: "E:\\logs\\full.log",
    });
    expect(error.failedItem).toContain("playwright-chromium-runtime.test.ts");
  });

  it("prefers verify firstFailure metadata over unrelated earlier output", () => {
    const output = [
      "Error: harmless diagnostic from an earlier passing command",
      'VERIDIA_VERIFY_RESULT={"passed":false,"failures":["Production build"],"firstFailure":{"name":"Production build","classification":"DETERMINISTIC","failedItem":"app/page.tsx","summary":"TypeScript compilation failed","status":1}}',
    ].join("\n");

    expect(inferVerifyFailure(output, "E:\\logs\\full.log")).toMatchObject({
      stage: "PRODUCTION_BUILD",
      classification: "DETERMINISTIC",
      failedItem: "app/page.tsx",
      summary: "TypeScript compilation failed",
    });
  });

  it("Electron builder network failure remains PACKAGE, not FULL", () => {
    const error = new ReleaseStageError({
      stage: "PACKAGE",
      classification: "TRANSIENT_NETWORK",
      command: "electron-builder --win nsis",
      summary: "SHASUMS256.txt request ETIMEDOUT",
      detailLog: "E:\\logs\\package.log",
    });
    const parsed = parseReleaseResult(releaseResultLine(error));

    expect(parsed).toMatchObject({
      stage: "PACKAGE",
      classification: "TRANSIENT_NETWORK",
      summary: "SHASUMS256.txt request ETIMEDOUT",
    });
    expect(parsed?.stage).not.toBe("FULL");
  });

  it.each([
    ["TypeScript compile failed", "DETERMINISTIC"],
    ["read ECONNRESET", "TRANSIENT_NETWORK"],
    ["Timeout awaiting 'request' for 10000ms", "TRANSIENT_NETWORK"],
    ["Test timed out in 5000ms", "TEST_TIMEOUT"],
    ["ENOSPC: disk full", "ENVIRONMENT"],
    ["checksum mismatch", "DETERMINISTIC"],
  ])("classifies %s", (message, expected) => {
    expect(classifyReleaseFailure(message)).toBe(expected);
  });

  it("does not automatically call a timeout flaky", () => {
    expect(classifyReleaseFailure("Test timed out in 5000ms")).toBe(
      "TEST_TIMEOUT",
    );
  });
});

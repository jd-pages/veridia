import { describe, expect, it } from "vitest";

import {
  classifyReadOnlyNetworkFailure,
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
    ["checksum mismatch", "DETERMINISTIC_INTEGRITY"],
  ])("classifies %s", (message, expected) => {
    expect(classifyReleaseFailure(message)).toBe(expected);
  });

  it("does not automatically call a timeout flaky", () => {
    expect(classifyReleaseFailure("Test timed out in 5000ms")).toBe(
      "TEST_TIMEOUT",
    );
  });

  it.each([
    ['Get "https://api.github.com/repos/jd-pages/veridia": EOF'],
    ["unexpected EOF"],
    ["unexpected end of file"],
    ["connection closed"],
    ["connection closed before response"],
    ["connection reset by peer"],
    ["socket hang up"],
  ])("classifies read-only network context as transient: %s", (message) => {
    expect(classifyReadOnlyNetworkFailure(message)).toBe("TRANSIENT_NETWORK");
  });

  it("does not classify a local file parse EOF as a network failure", () => {
    expect(classifyReleaseFailure("Local JSON parse failed: unexpected EOF")).toBe(
      "UNKNOWN",
    );
  });

  it("preserves authentication and deterministic 404 classifications", () => {
    expect(
      classifyReadOnlyNetworkFailure("authentication failed: bad credentials"),
    ).toBe("AUTHENTICATION");
    expect(
      classifyReadOnlyNetworkFailure("HTTP 404: release not found", "DETERMINISTIC"),
    ).toBe("DETERMINISTIC");
  });

  it.each([
    ["schannel: failed to receive handshake", "TRANSIENT_NETWORK"],
    ["SSL/TLS connection failed", "TRANSIENT_NETWORK"],
    ["Failed to connect to github.com", "TRANSIENT_NETWORK"],
    ["Could not connect to server", "TRANSIENT_NETWORK"],
    ["Could not resolve host: github.com", "TRANSIENT_NETWORK"],
    ["request ETIMEDOUT", "TRANSIENT_NETWORK"],
    ["read ECONNRESET", "TRANSIENT_NETWORK"],
  ])("preserves existing network classification: %s", (message, expected) => {
    expect(classifyReadOnlyNetworkFailure(message)).toBe(expected);
  });
});

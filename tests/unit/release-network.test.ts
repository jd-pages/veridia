import { describe, expect, it, vi } from "vitest";

import {
  READ_ONLY_NETWORK_ATTEMPTS,
  READ_ONLY_NETWORK_BACKOFF_MS,
  retryReadOnlyNetworkOperation,
  retryReadOnlyNetworkOperationSync,
} from "../../scripts/release-network.mjs";
import type { NetworkAttempt } from "../../scripts/release-network.mjs";

describe("shared read-only network retry", () => {
  it("uses exactly two attempts and a 500ms backoff by default", () => {
    expect(READ_ONLY_NETWORK_ATTEMPTS).toBe(2);
    expect(READ_ONLY_NETWORK_BACKOFF_MS).toBe(500);
  });

  it("overrides a provisional UNKNOWN EOF classification in network context", async () => {
    const error = Object.assign(new Error("Get https://api.github.com: EOF"), {
      classification: "UNKNOWN",
    });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retryReadOnlyNetworkOperation("gh api GET", operation, {
      sleep: async () => undefined,
    })).rejects.toMatchObject({
      classification: "TRANSIENT_NETWORK",
      attempt: 2,
      maxAttempts: 2,
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("returns structured async attempt duration and classification", async () => {
    const attempts: NetworkAttempt[] = [];
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed before response"))
      .mockResolvedValueOnce("PASS");

    await expect(retryReadOnlyNetworkOperation("Release metadata GET", operation, {
      sleep: async () => undefined,
      onAttempt: (attempt) => attempts.push(attempt),
    })).resolves.toBe("PASS");
    expect(attempts).toMatchObject([
      { attempt: 1, success: false, classification: "TRANSIENT_NETWORK" },
      { attempt: 2, success: true, classification: null },
    ]);
    expect(attempts.every((attempt) => typeof attempt.elapsedMs === "number")).toBe(true);
  });

  it("uses the same contextual classification and structure for sync reads", () => {
    const attempts: NetworkAttempt[] = [];
    const sleep = vi.fn();
    const operation = vi.fn()
      .mockImplementationOnce(() => { throw new Error("unexpected end of file"); })
      .mockReturnValueOnce("PASS");

    expect(retryReadOnlyNetworkOperationSync("git ls-remote", operation, {
      sleep,
      onAttempt: (attempt) => attempts.push(attempt),
    })).toBe("PASS");
    expect(sleep).toHaveBeenCalledWith(500);
    expect(attempts).toMatchObject([
      { attempt: 1, success: false, classification: "TRANSIENT_NETWORK" },
      { attempt: 2, success: true, classification: null },
    ]);
  });

  it("never retries authentication or deterministic resource absence", async () => {
    for (const error of [
      Object.assign(new Error("authentication failed: bad credentials"), {
        classification: "AUTHENTICATION",
      }),
      Object.assign(new Error("HTTP 404: Not Found"), {
        classification: "DETERMINISTIC",
      }),
    ]) {
      const operation = vi.fn().mockRejectedValue(error);
      await expect(retryReadOnlyNetworkOperation("GitHub metadata GET", operation, {
        sleep: async () => undefined,
      })).rejects.toBe(error);
      expect(operation).toHaveBeenCalledOnce();
    }
  });
});

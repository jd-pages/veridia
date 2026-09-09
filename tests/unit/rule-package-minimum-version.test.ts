import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import packageJson from "@/package.json";
import {
  applyRulePayload,
  validateRulePayload,
} from "@/lib/rules/package";
import { createRulePackageManifest } from "@/lib/rules/publish-manifest";
import {
  isRulePackageCompatible,
  validateRuleManifest,
  validateRulePackageCounts,
  verifyRuleManifestSignature,
} from "@/lib/rules/sync";
import {
  assertRulePackageCompatibleWithApp,
  assertRulePackageMinimumVersionContract,
  assertValidRulePackageVersion,
  compareRulePackageVersions,
} from "@/lib/rules/version-contract";
import type { RulePackagePayload } from "@/lib/rules/types";
import builtinRules from "@/rules/default-rules.json";

const downloadUrl =
  "https://github.com/jd-pages/veridia-rules/releases/download/rules-2026.09.09.1/veridia-rules.zip";

function payload(minimumAppVersion = packageJson.version) {
  return validateRulePayload({
    ...structuredClone(builtinRules),
    ruleVersion: "rules-2026.09.09.1",
    minimumAppVersion,
  });
}

async function packageArtifacts(rulePayload: RulePackagePayload) {
  const zip = new JSZip();
  zip.file("rules.json", JSON.stringify(rulePayload, null, 2));
  const packageBytes = await zip.generateAsync({ type: "nodebuffer" });
  return {
    packageBytes,
    manifest: createRulePackageManifest({
      payload: rulePayload,
      packageBytes,
      downloadUrl,
    }),
  };
}

function errorCode(action: () => unknown) {
  try {
    action();
    return null;
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? String(error.code)
      : null;
  }
}

function inaccessibleDatabase(onAccess: () => void) {
  return new Proxy(
    {},
    {
      get() {
        onAccess();
        throw new Error("数据库不应在版本门禁前被访问");
      },
    },
  ) as PrismaClient;
}

describe("RULE_PACKAGE_MINIMUM_APP_VERSION_CONSISTENCY", () => {
  it("正常规则包的 Manifest、Payload、hash 与当前应用兼容", async () => {
    const currentPayload = payload();
    const { packageBytes, manifest } = await packageArtifacts(currentPayload);
    expect(validateRuleManifest(manifest).minimumAppVersion).toBe(
      currentPayload.minimumAppVersion,
    );
    expect(createHash("sha256").update(packageBytes).digest("hex")).toBe(
      manifest.sha256,
    );
    expect(() =>
      assertRulePackageMinimumVersionContract({
        appVersion: packageJson.version,
        manifestMinimumAppVersion: manifest.minimumAppVersion,
        payloadMinimumAppVersion: currentPayload.minimumAppVersion,
      }),
    ).not.toThrow();
  });

  it("Manifest 与 Payload 最低版本完全相等时通过", () => {
    expect(() =>
      assertRulePackageMinimumVersionContract({
        appVersion: "1.2.0",
        manifestMinimumAppVersion: "1.1.22",
        payloadMinimumAppVersion: "1.1.22",
      }),
    ).not.toThrow();
  });

  it("受信 Manifest 较低而 Payload 高于 App 时按 mismatch 拒绝", async () => {
    const tooNewPayload = payload("99.0.0");
    const { packageBytes, manifest: generated } =
      await packageArtifacts(tooNewPayload);
    const mismatchedManifest = { ...generated, minimumAppVersion: "1.1.0" };
    const manifestBytes = Buffer.from(
      `${JSON.stringify(mismatchedManifest)}\n`,
    );
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = sign(null, manifestBytes, privateKey).toString("base64");
    const verifiedManifest = validateRuleManifest(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    expect(
      verifyRuleManifestSignature(
        manifestBytes,
        signature,
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    ).toBe(true);
    expect(createHash("sha256").update(packageBytes).digest("hex")).toBe(
      verifiedManifest.sha256,
    );
    expect(validateRulePackageCounts(tooNewPayload, verifiedManifest)).toEqual(
      expect.any(Object),
    );
    expect(
      errorCode(() =>
        assertRulePackageMinimumVersionContract({
          appVersion: packageJson.version,
          manifestMinimumAppVersion: verifiedManifest.minimumAppVersion,
          payloadMinimumAppVersion: tooNewPayload.minimumAppVersion,
        }),
      ),
    ).toBe("MANIFEST_PAYLOAD_VERSION_MISMATCH");
  });

  it("Manifest 高于 App、Payload 较低时由 Manifest gate 拒绝", () => {
    expect(
      errorCode(() => assertRulePackageCompatibleWithApp("1.1.22", "99.0.0")),
    ).toBe("APP_VERSION_INCOMPATIBLE");
  });

  it("两个版本都兼容但彼此不一致时拒绝", () => {
    expect(
      errorCode(() =>
        assertRulePackageMinimumVersionContract({
          appVersion: "1.2.0",
          manifestMinimumAppVersion: "1.1.21",
          payloadMinimumAppVersion: "1.1.22",
        }),
      ),
    ).toBe("MANIFEST_PAYLOAD_VERSION_MISMATCH");
  });

  it("Manifest 缺失 minimumAppVersion 时 fail closed", async () => {
    const currentPayload = payload();
    const { manifest } = await packageArtifacts(currentPayload);
    const missing = { ...manifest } as Partial<typeof manifest>;
    delete missing.minimumAppVersion;
    expect(errorCode(() => validateRuleManifest(missing))).toBe(
      "INVALID_VERSION",
    );
  });

  it("Payload 缺失 minimumAppVersion 时 fail closed", () => {
    const missing = structuredClone(builtinRules) as Partial<typeof builtinRules>;
    delete missing.minimumAppVersion;
    expect(errorCode(() => validateRulePayload(missing))).toBe(
      "INVALID_VERSION",
    );
  });

  it("双方都缺失 minimumAppVersion 时均 fail closed", async () => {
    const currentPayload = payload();
    const { manifest } = await packageArtifacts(currentPayload);
    const missingManifest = { ...manifest } as Partial<typeof manifest>;
    delete missingManifest.minimumAppVersion;
    const missingPayload = structuredClone(builtinRules) as Partial<typeof builtinRules>;
    delete missingPayload.minimumAppVersion;
    expect(errorCode(() => validateRuleManifest(missingManifest))).toBe(
      "INVALID_VERSION",
    );
    expect(errorCode(() => validateRulePayload(missingPayload))).toBe(
      "INVALID_VERSION",
    );
  });

  it("Manifest 非法版本值全部 fail closed", async () => {
    const { manifest } = await packageArtifacts(payload());
    const invalid = [
      "",
      "abc",
      "1",
      "1.2",
      "1.2.3.4",
      null,
      123,
      "9".repeat(10_000),
    ];
    for (const value of invalid) {
      expect(
        errorCode(() =>
          validateRuleManifest({ ...manifest, minimumAppVersion: value }),
        ),
      ).toBe("INVALID_VERSION");
    }
  });

  it("Payload 非法版本值全部 fail closed", () => {
    const invalid = [
      "",
      "abc",
      "1",
      "1.2",
      "1.2.3.4",
      null,
      123,
      "9".repeat(10_000),
    ];
    for (const value of invalid) {
      expect(
        errorCode(() =>
          validateRulePayload({
            ...structuredClone(builtinRules),
            minimumAppVersion: value,
          }),
        ),
      ).toBe("INVALID_VERSION");
    }
  });

  it("App 等于最低版本时通过", () => {
    expect(() =>
      assertRulePackageCompatibleWithApp("1.1.22", "1.1.22"),
    ).not.toThrow();
  });

  it("App 低于最低版本时使用兼容性错误拒绝", () => {
    expect(
      errorCode(() =>
        assertRulePackageCompatibleWithApp("1.1.22", "1.2.0"),
      ),
    ).toBe("APP_VERSION_INCOMPATIBLE");
  });

  it("App 高于最低版本时通过", () => {
    expect(() =>
      assertRulePackageCompatibleWithApp("2.0.0", "1.99.99"),
    ).not.toThrow();
  });

  it("不兼容 Payload 在任何数据库读取或写入前拒绝", async () => {
    let databaseAccesses = 0;
    await expect(
      applyRulePayload(
        payload("99.0.0"),
        "GITHUB",
        inaccessibleDatabase(() => {
          databaseAccesses += 1;
        }),
      ),
    ).rejects.toMatchObject({ code: "APP_VERSION_INCOMPATIBLE" });
    expect(databaseAccesses).toBe(0);
  });

  it("Publisher 从 Payload 复制相同最低版本并绑定包 hash", async () => {
    const currentPayload = payload("1.2.0-beta.1");
    const { packageBytes, manifest } = await packageArtifacts(currentPayload);
    expect(manifest.minimumAppVersion).toBe(
      currentPayload.minimumAppVersion,
    );
    expect(manifest.sha256).toBe(
      createHash("sha256").update(packageBytes).digest("hex"),
    );
  });

  it("Restore 与 reapply 共用 apply 前版本门禁且零数据库访问", async () => {
    const incompatible = payload("99.0.0");
    for (const source of ["RESTORE", "GITHUB"] as const) {
      let databaseAccesses = 0;
      await expect(
        applyRulePayload(
          incompatible,
          source,
          inaccessibleDatabase(() => {
            databaseAccesses += 1;
          }),
        ),
      ).rejects.toMatchObject({ code: "APP_VERSION_INCOMPATIBLE" });
      expect(databaseAccesses).toBe(0);
    }
  });

  it("SemVer 使用数值顺序而非字符串字典序", () => {
    expect(compareRulePackageVersions("1.1.9", "1.1.10")).toBeLessThan(0);
    expect(compareRulePackageVersions("1.1.22", "1.2.0")).toBeLessThan(0);
    expect(compareRulePackageVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareRulePackageVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(isRulePackageCompatible("1.10.0", "1.9.0")).toBe(true);
  });

  it("SemVer prerelease 低于对应正式版本且 build metadata 不影响优先级", () => {
    expect(
      compareRulePackageVersions("1.2.0-beta.1", "1.2.0"),
    ).toBeLessThan(0);
    expect(
      compareRulePackageVersions("1.2.0-beta.2", "1.2.0-beta.11"),
    ).toBeLessThan(0);
    expect(compareRulePackageVersions("1.2.0+one", "1.2.0+two")).toBe(0);
    expect(() => assertValidRulePackageVersion("1.2.0-beta.1+build.7")).not.toThrow();
  });
});

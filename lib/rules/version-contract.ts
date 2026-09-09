const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAX_VERSION_LENGTH = 256;

interface ParsedVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
}

function versionError(label: string, value: unknown) {
  const rendered = typeof value === "string" ? value : String(value);
  return Object.assign(new Error(`${label}不是有效的 SemVer：${rendered}`), {
    code: "INVALID_VERSION",
  });
}

export function assertValidRulePackageVersion(
  value: unknown,
  label = "最低软件版本",
) {
  const match =
    typeof value === "string" && value.length <= MAX_VERSION_LENGTH
      ? SEMVER_PATTERN.exec(value)
      : null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VERSION_LENGTH ||
    !match ||
    match[0] !== value
  ) {
    throw versionError(label, value);
  }
  return value;
}

function parseVersion(value: string, label: string): ParsedVersion {
  const validated = assertValidRulePackageVersion(value, label);
  const match = SEMVER_PATTERN.exec(validated)!;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? null,
  };
}

function comparePrerelease(left: string[] | null, right: string[] | null) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareRulePackageVersions(left: string, right: string) {
  const a = parseVersion(left, "软件版本");
  const b = parseVersion(right, "规则包最低软件版本");
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function isRulePackageVersionCompatible(
  appVersion: string,
  minimumAppVersion: string,
) {
  return compareRulePackageVersions(appVersion, minimumAppVersion) >= 0;
}

export function assertRulePackageCompatibleWithApp(
  appVersion: string,
  minimumAppVersion: string,
) {
  assertValidRulePackageVersion(appVersion, "当前软件版本");
  assertValidRulePackageVersion(
    minimumAppVersion,
    "规则包最低软件版本",
  );
  if (!isRulePackageVersionCompatible(appVersion, minimumAppVersion)) {
    throw Object.assign(new Error("当前软件版本低于规则包最低兼容版本"), {
      code: "APP_VERSION_INCOMPATIBLE",
    });
  }
}

export function assertRulePackageMinimumVersionContract(input: {
  appVersion: string;
  manifestMinimumAppVersion: string;
  payloadMinimumAppVersion: string;
}) {
  assertValidRulePackageVersion(
    input.manifestMinimumAppVersion,
    "规则清单最低软件版本",
  );
  assertValidRulePackageVersion(
    input.payloadMinimumAppVersion,
    "规则包内容最低软件版本",
  );
  if (input.manifestMinimumAppVersion !== input.payloadMinimumAppVersion) {
    throw Object.assign(
      new Error("规则清单与规则包内容的最低软件版本不一致"),
      { code: "MANIFEST_PAYLOAD_VERSION_MISMATCH" },
    );
  }
  assertRulePackageCompatibleWithApp(
    input.appVersion,
    input.payloadMinimumAppVersion,
  );
}

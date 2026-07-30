import { createHash, verify } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { RuleSyncState } from "@prisma/client";
import packageJson from "@/package.json";
import { prisma } from "@/lib/db";
import builtinRules from "@/rules/default-rules.json";
import { ruleSyncConfiguration } from "./config";
import {
  applyRulePayload,
  validateRulePayload,
} from "./package";
import {
  RULE_PACKAGE_SCHEMA_VERSION,
  type RuleCounts,
  type RulePackageManifest,
} from "./types";

const MAX_RULE_PACKAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

let builtinInitializationPromise: Promise<RuleSyncState> | null = null;

function countsFromState(value: string | null | undefined): RuleCounts {
  try {
    return JSON.parse(value || "{}") as RuleCounts;
  } catch {
    return { products: 0, activities: 0, stageGroups: 0, topicRules: 0 };
  }
}

function assertAllowedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error("规则下载地址不是受信任的 GitHub HTTPS 地址");
  }
  return url;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  accept = "application/vnd.github+json",
) {
  assertAllowedUrl(url);
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": `VERIDIA/${packageJson.version}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GitHub 返回 HTTP ${response.status}`);
  }
  assertAllowedUrl(response.url);
  return response;
}

interface PublicReleaseAsset {
  name: string;
  url: string;
}

async function fetchPublicReleaseAsset(
  repository: string,
  assetName: string,
  timeoutMs: number,
) {
  const releaseResponse = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/releases/latest`,
    timeoutMs,
  );
  const release = (await releaseResponse.json()) as {
    assets?: PublicReleaseAsset[];
  };
  const asset = release.assets?.find((item) => item.name === assetName);
  if (!asset) {
    throw new Error(`GitHub Release 缺少 ${assetName}`);
  }
  return fetchWithTimeout(asset.url, timeoutMs, "application/octet-stream");
}

async function fetchReleaseDownload(
  repository: string,
  directUrl: string,
  assetName: string,
  timeoutMs: number,
) {
  try {
    return await fetchWithTimeout(
      directUrl,
      timeoutMs,
      "application/octet-stream",
    );
  } catch {
    // Some Windows networks allow api.github.com and release-assets but block
    // github.com download redirects. The public asset API remains anonymous,
    // carries no token, and the downloaded bytes still undergo all signature,
    // size and hash verification below.
    return fetchPublicReleaseAsset(repository, assetName, timeoutMs);
  }
}

function compareSemver(left: string, right: string) {
  const parse = (value: string) =>
    value
      .split(/[.+-]/u)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function isRulePackageCompatible(
  appVersion: string,
  minimumAppVersion: string,
) {
  return compareSemver(appVersion, minimumAppVersion) >= 0;
}

export function validateRuleManifest(input: unknown): RulePackageManifest {
  if (!input || typeof input !== "object") throw new Error("规则清单格式无效");
  const value = input as Record<string, unknown>;
  const manifest = {
    ruleVersion: String(value.ruleVersion || ""),
    schemaVersion: Number(value.schemaVersion),
    publishedAt: String(value.publishedAt || ""),
    minimumAppVersion: String(value.minimumAppVersion || ""),
    downloadUrl: String(value.downloadUrl || ""),
    fileSize: Number(value.fileSize),
    sha256: String(value.sha256 || "").toLowerCase(),
    productCount: Number(value.productCount),
    activityCount: Number(value.activityCount),
    stageGroupCount: Number(value.stageGroupCount),
    topicRuleCount: Number(value.topicRuleCount),
    templateVersion: value.templateVersion
      ? String(value.templateVersion)
      : undefined,
    templateConfigSha256: value.templateConfigSha256
      ? String(value.templateConfigSha256).toLowerCase()
      : undefined,
  };
  if (!/^rules-\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(manifest.ruleVersion)) {
    throw new Error("规则版本格式无效");
  }
  if (manifest.schemaVersion !== RULE_PACKAGE_SCHEMA_VERSION) {
    throw new Error("规则 Schema 与当前软件不兼容");
  }
  if (
    !Number.isSafeInteger(manifest.fileSize) ||
    manifest.fileSize <= 0 ||
    manifest.fileSize > MAX_RULE_PACKAGE_BYTES
  ) {
    throw new Error("规则包文件大小无效");
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    throw new Error("规则包 SHA-256 无效");
  }
  if (
    manifest.templateConfigSha256 &&
    !/^[a-f0-9]{64}$/u.test(manifest.templateConfigSha256)
  ) {
    throw new Error("表格模板配置 SHA-256 无效");
  }
  assertAllowedUrl(manifest.downloadUrl);
  return manifest;
}

export function verifyRuleManifestSignature(
  manifestBytes: Buffer,
  signatureBase64: string,
  publicKey: string,
) {
  return verify(
    null,
    manifestBytes,
    publicKey,
    Buffer.from(signatureBase64.trim(), "base64"),
  );
}

async function readLatestRelease() {
  const config = ruleSyncConfiguration();
  if (!config.configured) {
    throw Object.assign(new Error("尚未配置独立 GitHub 规则仓库或签名公钥"), {
      code: "RULE_REPOSITORY_NOT_CONFIGURED",
    });
  }
  // Use public latest-download URLs rather than the GitHub REST API so normal
  // clients remain anonymous and are not affected by the low unauthenticated
  // API rate limit. Redirect targets are still restricted to GitHub hosts.
  const releaseBase = `https://github.com/${config.repository}/releases/latest/download`;
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetchReleaseDownload(
      config.repository,
      `${releaseBase}/manifest.json`,
      "manifest.json",
      20_000,
    ),
    fetchReleaseDownload(
      config.repository,
      `${releaseBase}/manifest.sig`,
      "manifest.sig",
      20_000,
    ),
  ]);
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
  const signature = (await signatureResponse.text()).trim();
  if (!verifyRuleManifestSignature(
    manifestBytes,
    signature,
    ruleSyncConfiguration().publicKey,
  )) {
    throw Object.assign(new Error("规则清单数字签名校验失败"), {
      code: "RULE_SIGNATURE_INVALID",
    });
  }
  const manifest = validateRuleManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const expectedPrefix = `https://github.com/${config.repository}/releases/download/${manifest.ruleVersion}/`;
  if (!manifest.downloadUrl.startsWith(expectedPrefix)) {
    throw new Error("规则包下载地址与规则仓库或规则版本不一致");
  }
  return {
    manifest,
    manifestBytes,
    packageAssetUrl: manifest.downloadUrl,
  };
}

async function initializeBuiltinRules() {
  const current = await prisma.ruleSyncState.findUnique({
    where: { id: "active" },
  });
  if (current) return current;

  const existingRuleCount = await prisma.topicRule.count();
  if (existingRuleCount > 0) {
    await prisma.$transaction(async (tx) => {
      for (const group of validateRulePayload(builtinRules).stageGroups) {
        await tx.ruleStageGroup.upsert({
          where: { key: group.key },
          create: {
            key: group.key,
            label: group.label,
            canonicalStages: JSON.stringify(group.canonicalStages),
            bodyTerms: JSON.stringify(group.bodyTerms),
            requiredTopic: group.requiredTopic,
            sortOrder: group.sortOrder,
            status: group.status,
            ruleVersion: "builtin-2026.07.29.1",
            ruleSource: "BUILTIN",
          },
          update: {},
        });
      }
      const [products, activities, stageGroups, topicRules] =
        await Promise.all([
          tx.product.count({ where: { deletedAt: null } }),
          tx.campaign.count({ where: { deletedAt: null } }),
          tx.ruleStageGroup.count(),
          tx.topicRule.count(),
        ]);
      await tx.ruleSyncState.upsert({
        where: { id: "active" },
        create: {
          id: "active",
          currentVersion: "builtin-2026.07.29.1",
          schemaVersion: RULE_PACKAGE_SCHEMA_VERSION,
          source: "BUILTIN",
          status: "USING_BUILTIN",
          countsJson: JSON.stringify({
            products,
            activities,
            stageGroups,
            topicRules,
          }),
        },
        update: {},
      });
    });
  } else {
    await applyRulePayload(validateRulePayload(builtinRules), "BUILTIN");
  }
  return prisma.ruleSyncState.findUniqueOrThrow({ where: { id: "active" } });
}

export async function ensureBuiltinRules() {
  if (!builtinInitializationPromise) {
    builtinInitializationPromise = initializeBuiltinRules().finally(() => {
      builtinInitializationPromise = null;
    });
  }
  return builtinInitializationPromise;
}

export async function getRuleSyncStatus() {
  const state = await ensureBuiltinRules();
  const config = ruleSyncConfiguration();
  return {
    configured: config.configured,
    repository: config.repository || null,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    schemaVersion: state.schemaVersion,
    templateVersion: state.templateVersion,
    templateSchemaVersion: state.templateSchemaVersion,
    source: state.source,
    status: state.status,
    counts: countsFromState(state.countsJson),
    lastCheckedAt: state.lastCheckedAt,
    lastSyncedAt: state.lastSyncedAt,
  };
}

export async function checkLatestRules(force = false) {
  const state = await ensureBuiltinRules();
  const now = new Date();
  if (!ruleSyncConfiguration().configured) {
    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: {
        status:
          state.source === "BUILTIN" ? "USING_BUILTIN" : state.status,
        lastCheckedAt: now,
      },
    });
    return getRuleSyncStatus();
  }
  if (!force && state.lastCheckedAt) {
    const last = state.lastCheckedAt;
    if (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate()
    ) {
      return getRuleSyncStatus();
    }
  }
  try {
    const { manifest } = await readLatestRelease();
    const status =
      manifest.ruleVersion === state.currentVersion
        ? "UP_TO_DATE"
        : "UPDATE_AVAILABLE";
    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: {
        latestVersion: manifest.ruleVersion,
        status,
        manifestJson: JSON.stringify(manifest),
        lastCheckedAt: now,
      },
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "RULE_CHECK_FAILED";
    await prisma.$transaction([
      prisma.ruleSyncState.update({
        where: { id: "active" },
        data: {
          status: "FAILED",
          lastCheckedAt: now,
        },
      }),
      prisma.ruleSyncHistory.create({
        data: {
          ruleVersion: state.currentVersion,
          schemaVersion: state.schemaVersion,
          source: "GITHUB",
          status: "FAILED",
          errorCode: code,
          message: "暂时无法获取最新规则，已继续使用本地规则。",
          completedAt: now,
        },
      }),
    ]);
  }
  return getRuleSyncStatus();
}

export async function synchronizeLatestRules() {
  const state = await ensureBuiltinRules();
  const history = await prisma.ruleSyncHistory.create({
    data: {
      ruleVersion: state.currentVersion,
      schemaVersion: state.schemaVersion,
      source: "GITHUB",
      status: "DOWNLOADING",
    },
  });
  let temporaryDirectory = "";
  try {
    const { manifest, packageAssetUrl } = await readLatestRelease();
    if (
      !isRulePackageCompatible(
        packageJson.version,
        manifest.minimumAppVersion,
      )
    ) {
      throw Object.assign(new Error("当前软件版本低于规则包最低兼容版本"), {
        code: "APP_VERSION_INCOMPATIBLE",
      });
    }
    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: {
        status: "DOWNLOADING",
        latestVersion: manifest.ruleVersion,
        lastCheckedAt: new Date(),
      },
    });
    const packageResponse = await fetchReleaseDownload(
      ruleSyncConfiguration().repository,
      packageAssetUrl,
      path.posix.basename(new URL(packageAssetUrl).pathname),
      60_000,
    );
    const downloadedBytes = Buffer.from(await packageResponse.arrayBuffer());
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "veridia-rules-"),
    );
    const temporaryPackage = path.join(temporaryDirectory, "rules.zip");
    await fs.writeFile(temporaryPackage, downloadedBytes);
    const bytes = await fs.readFile(temporaryPackage);
    if (bytes.length !== manifest.fileSize) {
      throw Object.assign(new Error("规则包文件大小校验失败"), {
        code: "RULE_SIZE_MISMATCH",
      });
    }
    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: { status: "VERIFYING" },
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== manifest.sha256) {
      throw Object.assign(new Error("规则包 SHA-256 校验失败"), {
        code: "RULE_SHA256_MISMATCH",
      });
    }
    const zip = await JSZip.loadAsync(bytes);
    const rulesFile = zip.file("rules.json");
    if (!rulesFile) throw new Error("规则包缺少 rules.json");
    const payload = validateRulePayload(
      JSON.parse(await rulesFile.async("string")),
    );
    if (manifest.templateVersion && !payload.importExportTemplates) {
      throw new Error("规则清单声明了表格模板，但规则包中缺少模板配置");
    }
    if (payload.importExportTemplates && manifest.templateConfigSha256) {
      const templateHash = createHash("sha256")
        .update(JSON.stringify(payload.importExportTemplates))
        .digest("hex");
      if (
        templateHash !== manifest.templateConfigSha256 ||
        payload.importExportTemplates.templateVersion !==
          manifest.templateVersion
      ) {
        throw new Error("表格模板版本或 SHA-256 校验失败");
      }
    }
    if (
      payload.ruleVersion !== manifest.ruleVersion ||
      payload.schemaVersion !== manifest.schemaVersion
    ) {
      throw new Error("规则包内容与清单版本不一致");
    }
    const counts = {
      products: payload.products.length,
      activities: payload.campaigns.length,
      stageGroups: payload.stageGroups.length,
      topicRules: payload.topicRules.length,
    };
    if (
      counts.products !== manifest.productCount ||
      counts.activities !== manifest.activityCount ||
      counts.stageGroups !== manifest.stageGroupCount ||
      counts.topicRules !== manifest.topicRuleCount
    ) {
      throw new Error("规则包数量统计与清单不一致");
    }
    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: { status: "APPLYING" },
    });
    await applyRulePayload(payload, "GITHUB");
    await prisma.$transaction([
      prisma.ruleSyncState.update({
        where: { id: "active" },
        data: {
          latestVersion: manifest.ruleVersion,
          manifestJson: JSON.stringify(manifest),
          status: "COMPLETED",
          lastCheckedAt: new Date(),
          lastSyncedAt: new Date(),
        },
      }),
      prisma.ruleSyncHistory.update({
        where: { id: history.id },
        data: {
          ruleVersion: manifest.ruleVersion,
          schemaVersion: manifest.schemaVersion,
          status: "COMPLETED",
          message: "规则同步完成",
          completedAt: new Date(),
        },
      }),
    ]);
    return getRuleSyncStatus();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "RULE_SYNC_FAILED";
    const technicalMessage =
      error instanceof Error ? error.message : "未知规则同步错误";
    await prisma.$transaction([
      prisma.ruleSyncState.update({
        where: { id: "active" },
        data: { status: "FAILED" },
      }),
      prisma.ruleSyncHistory.update({
        where: { id: history.id },
        data: {
          status: "FAILED",
          errorCode: code,
          message: "暂时无法获取最新规则，已继续使用本地规则。",
          detailsJson: JSON.stringify({ technicalMessage }),
          completedAt: new Date(),
        },
      }),
    ]);
    throw new Error("暂时无法获取最新规则，已继续使用本地规则。");
  } finally {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export async function restorePreviousRules() {
  const backup = await prisma.rulePackageBackup.findFirst({
    orderBy: { createdAt: "desc" },
  });
  if (!backup) throw new Error("没有可恢复的上一版规则");
  const payload = validateRulePayload(JSON.parse(backup.payloadJson));
  await applyRulePayload(payload, "RESTORE");
  await prisma.$transaction([
    prisma.rulePackageBackup.update({
      where: { id: backup.id },
      data: { restoredAt: new Date() },
    }),
    prisma.ruleSyncState.update({
      where: { id: "active" },
      data: { status: "RESTORED", source: "RESTORE" },
    }),
    prisma.ruleSyncHistory.create({
      data: {
        ruleVersion: payload.ruleVersion,
        schemaVersion: payload.schemaVersion,
        source: "RESTORE",
        status: "RESTORED",
        message: "已恢复上一版规则",
        completedAt: new Date(),
      },
    }),
  ]);
  return getRuleSyncStatus();
}

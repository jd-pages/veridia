import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  collectGitRevisionSourceFingerprint,
  hashSoftwareReleaseFile,
  packageVersion,
  SOFTWARE_RELEASE_VALIDATION_MODES,
  softwareReleaseArtifactNames,
  validateSoftwareReleaseArtifacts,
} from "./software-release-artifacts.mjs";
import { retryReadOnlyNetworkOperationSync } from "./release-network.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "jd-pages/veridia";
const releaseWorkflow = "veridia-release.yml";

function command(executable, args, options = {}) {
  const execute = () => {
    const result = spawnSync(executable, args, {
      cwd: options.cwd || projectRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs || 15 * 60_000,
      maxBuffer: 100 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${executable} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.status}`,
      );
    }
    return (result.stdout || "").trim();
  };
  return options.readOnly
    ? retryReadOnlyNetworkOperationSync(`${executable} ${args.join(" ")}`, execute)
    : execute();
}

function git(args, options) {
  return command("git", args, options);
}

function gh(args, options) {
  return command("gh", args, options);
}

export function classifyBinaryResumeRun(run, tagCommit) {
  if (!run || run.headSha !== tagCommit || run.headBranch !== `v${run.version}`) {
    throw new Error("Release Workflow does not belong to the immutable target Tag commit");
  }
  const steps = new Map(
    (run.jobs || []).flatMap((job) => job.steps || []).map((step) => [step.name, step]),
  );
  for (const name of [
    "正式 FULL 门禁（不读取开发机凭证）",
    "构建 NSIS 安装包和更新元数据",
    "检查自动更新发布三件套",
    "创建 Draft GitHub Release 并上传更新文件",
  ]) {
    if (steps.get(name)?.conclusion !== "success") {
      throw new Error(`Release Workflow evidence is incomplete: ${name}`);
    }
  }
  if (run.conclusion === "success") return "BINARY_PUBLISH_READY";
  const failures = [...steps.values()].filter((step) => step.conclusion === "failure");
  if (
    run.conclusion === "failure" &&
    failures.length === 1 &&
    failures[0].name === "校验 Draft Release 自动更新文件"
  ) {
    return "BINARY_PUBLISH_RECOVERABLE";
  }
  throw new Error("Release Workflow failure is not safely recoverable as binary publish");
}

export function planBinaryResumeAssets(release, manifest) {
  if (!release?.draft || release.prerelease) {
    throw new Error("Binary Resume requires a non-prerelease Draft Release");
  }
  const remote = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  const reuse = [];
  const upload = [];
  for (const file of manifest.files || []) {
    const asset = remote.get(file.name);
    if (!asset) {
      upload.push(file.name);
      continue;
    }
    if (
      asset.state !== "uploaded" ||
      asset.size !== file.size ||
      asset.digest !== `sha256:${file.sha256}`
    ) {
      throw new Error(`Existing Draft asset differs; refusing overwrite: ${file.name}`);
    }
    reuse.push(file.name);
  }
  return { reuse, upload };
}

export function createRecoveredArtifactManifest({
  projectRoot: root,
  version,
  directory,
  tagCommit,
  runId,
}) {
  const files = softwareReleaseArtifactNames(version).map((name) => {
    const file = path.join(directory, name);
    const stat = fs.statSync(file);
    return {
      name,
      size: stat.size,
      sha256: hashSoftwareReleaseFile(file, "sha256", "hex"),
      sha512: hashSoftwareReleaseFile(file, "sha512", "base64"),
    };
  });
  return {
    schemaVersion: 2,
    version,
    commitSha: tagCommit,
    releaseCommit: tagCommit,
    tagCommit,
    buildTimestamp: null,
    sourceFingerprint: collectGitRevisionSourceFingerprint(root, tagCommit),
    provenance: "RECOVERED_FROM_EXACT_RELEASE_RUN",
    releaseRunId: Number(runId),
    files,
  };
}

export function verifyReleaseAssetDigests(release, validation) {
  const assets = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  for (const file of validation.files) {
    const asset = assets.get(file.name);
    if (
      !asset ||
      asset.state !== "uploaded" ||
      asset.size !== file.size ||
      asset.digest !== `sha256:${file.sha256}`
    ) {
      throw new Error(`GitHub Asset API identity mismatch: ${file.name}`);
    }
  }
  return true;
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function releaseMetadata(version) {
  const releases = JSON.parse(
    gh(["api", `repos/${repository}/releases`, "--paginate"], { readOnly: true }),
  );
  const release = releases.find((value) => value.tag_name === `v${version}`);
  if (!release) throw new Error(`Draft Release v${version} does not exist`);
  return release;
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function downloadRunArtifact(runId, version, directory) {
  gh([
    "run", "download", String(runId), "--repo", repository,
    "--name", `veridia-release-${version}`, "--dir", directory,
  ], { readOnly: true, timeoutMs: 30 * 60_000 });
}

function prepareMissingAssetSource({ runId, version, tagCommit, directory }) {
  downloadRunArtifact(runId, version, directory);
  const manifestPath = findFile(directory, "release-manifest.json");
  const installerPath = findFile(directory, `VERIDIA-Setup-${version}.exe`);
  if (!manifestPath || !installerPath) {
    throw new Error("Exact Release Workflow artifact lacks Manifest or Installer");
  }
  const assetDirectory = path.dirname(installerPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateSoftwareReleaseArtifacts({
    projectRoot,
    version,
    directory: assetDirectory,
    mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
    manifest,
    expectedTagCommit: tagCommit,
  });
  return { manifest, assetDirectory };
}

function uploadMissingAssets(version, names, directory) {
  for (const name of names) {
    gh([
      "release", "upload", `v${version}`, path.join(directory, name),
      "--repo", repository,
    ]);
  }
}

function releaseRun(version, tagCommit, runId) {
  const id = runId || JSON.parse(
    gh([
      "run", "list", "--repo", repository, "--workflow", releaseWorkflow,
      "--branch", `v${version}`, "--event", "push", "--limit", "20",
      "--json", "databaseId,headSha,headBranch,status,conclusion",
    ], { readOnly: true }),
  ).find((run) => run.headSha === tagCommit)?.databaseId;
  if (!id) throw new Error(`No exact Tag Release Workflow found for v${version}`);
  const run = JSON.parse(gh([
    "run", "view", String(id), "--repo", repository,
    "--json", "databaseId,headSha,headBranch,status,conclusion,jobs,url",
  ], { readOnly: true }));
  return { ...run, version };
}

function expectedInstallerEvidence(runId, version) {
  const log = gh(["run", "view", String(runId), "--repo", repository, "--log"], {
    readOnly: true,
    timeoutMs: 5 * 60_000,
  });
  const name = `VERIDIA-Setup-${version}.exe`;
  const size = Number(log.match(new RegExp(`${name.replaceAll(".", "\\.")}：(\\d+) bytes`, "u"))?.[1]);
  const sha256 = log.match(/安装包 SHA-256：([a-f0-9]{64})/iu)?.[1]?.toLowerCase();
  if (!Number.isSafeInteger(size) || !sha256) {
    throw new Error("Exact Release Workflow installer evidence is missing");
  }
  return { name, size, sha256 };
}

function downloadDraft(version, directory) {
  gh(["release", "download", `v${version}`, "--repo", repository, "--dir", directory], {
    readOnly: true,
    timeoutMs: 30 * 60_000,
  });
}

async function confirmPublish(version) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(
      `只有准确输入“我确认发布现有 v${version} Draft”才会发布：`,
    );
    return answer.trim() === `我确认发布现有 v${version} Draft`;
  } finally {
    input.close();
  }
}

export async function runBinaryPublish() {
  const version = argument("version") || packageVersion(projectRoot);
  const runIdArgument = argument("run-id");
  const assetDirectoryArgument = argument("asset-directory");
  const dryRun = process.argv.includes("--dry-run");
  git(["fetch", "--quiet", "origin", "main", "--tags"], { readOnly: true });
  const tagCommit = git(["rev-parse", `v${version}^{commit}`]);
  const remoteTag = git(["ls-remote", "--tags", "origin", `refs/tags/v${version}^{}`], {
    readOnly: true,
  }).split(/\s+/u)[0];
  if (remoteTag !== tagCommit) throw new Error(`Remote Tag v${version} commit mismatch`);

  let release = releaseMetadata(version);
  const run = releaseRun(version, tagCommit, runIdArgument);
  const recoveryClassification = classifyBinaryResumeRun(run, tagCommit);
  const requiredNames = softwareReleaseArtifactNames(version);
  const initiallyMissing = requiredNames.filter(
    (name) => !(release.assets || []).some((asset) => asset.name === name),
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `veridia-binary-${version}-`));
  const draftDirectory = assetDirectoryArgument
    ? path.resolve(projectRoot, assetDirectoryArgument)
    : path.join(tempRoot, "draft");
  if (!assetDirectoryArgument) fs.mkdirSync(draftDirectory, { recursive: true });
  try {
    let referenceManifest = null;
    let confirmed = false;
    if (initiallyMissing.length > 0) {
      const reference = prepareMissingAssetSource({
        runId: run.databaseId,
        version,
        tagCommit,
        directory: path.join(tempRoot, "run-artifact"),
      });
      const initialPlan = planBinaryResumeAssets(release, reference.manifest);
      if (dryRun) {
        process.stdout.write(`${JSON.stringify({
          success: true,
          state: recoveryClassification,
          version,
          tagCommit,
          runId: run.databaseId,
          releaseId: release.id,
          draft: true,
          reuse: initialPlan.reuse,
          upload: initialPlan.upload,
          ready: true,
          dryRun: true,
        }, null, 2)}\n`);
        return;
      }
      if (!await confirmPublish(version)) {
        throw new Error("Binary publish confirmation did not match; Draft remains unchanged");
      }
      confirmed = true;
      uploadMissingAssets(version, initialPlan.upload, reference.assetDirectory);
      referenceManifest = reference.manifest;
      release = releaseMetadata(version);
    }
    if (!assetDirectoryArgument) downloadDraft(version, draftDirectory);
    const manifest = referenceManifest || createRecoveredArtifactManifest({
      projectRoot,
      version,
      directory: draftDirectory,
      tagCommit,
      runId: run.databaseId,
    });
    const evidence = expectedInstallerEvidence(run.databaseId, version);
    const installer = manifest.files.find((file) => file.name === evidence.name);
    if (installer?.size !== evidence.size || installer?.sha256 !== evidence.sha256) {
      throw new Error("Draft Installer differs from exact Release Workflow evidence");
    }
    const plan = planBinaryResumeAssets(release, manifest);
    if (plan.upload.length > 0) throw new Error(`Draft assets remain incomplete: ${plan.upload.join(", ")}`);
    const validation = validateSoftwareReleaseArtifacts({
      projectRoot,
      version,
      directory: draftDirectory,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest,
      expectedTagCommit: tagCommit,
    });
    verifyReleaseAssetDigests(release, validation);
    process.stdout.write(`${JSON.stringify({
      success: true,
      state: recoveryClassification,
      version,
      tagCommit,
      runId: run.databaseId,
      releaseId: release.id,
      draft: release.draft,
      prerelease: release.prerelease,
      files: validation.files.map(({ name, size, sha256, sha512 }) => ({
        name, size, sha256, sha512,
      })),
      reuse: plan.reuse,
      upload: plan.upload,
      ready: true,
      dryRun,
    }, null, 2)}\n`);
    if (dryRun) return;
    if (!confirmed && !await confirmPublish(version)) {
      throw new Error("Binary publish confirmation did not match; Draft remains unchanged");
    }
    gh([
      "release", "edit", `v${version}`, "--repo", repository,
      "--draft=false", "--prerelease=false", "--latest",
    ]);
    const published = JSON.parse(gh([
      "release", "view", `v${version}`, "--repo", repository,
      "--json", "tagName,isDraft,isPrerelease,url,assets",
    ], { readOnly: true }));
    if (published.isDraft || published.isPrerelease || published.tagName !== `v${version}`) {
      throw new Error("Published Release state verification failed");
    }
    const publishedMetadata = releaseMetadata(version);
    verifyReleaseAssetDigests(publishedMetadata, validation);
    const latest = JSON.parse(gh([
      "release", "view", "--repo", repository,
      "--json", "tagName,isDraft,isPrerelease,url",
    ], { readOnly: true }));
    if (
      latest.tagName !== `v${version}` ||
      latest.isDraft ||
      latest.isPrerelease
    ) {
      throw new Error("Published Release is not the verified Latest Release");
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    await runBinaryPublish();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

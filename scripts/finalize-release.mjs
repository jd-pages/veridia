import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  formatArtifactSize,
  packageVersion,
  validateSoftwareReleaseArtifacts,
} from "./software-release-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owner = "jd-pages";
const repository = "veridia";
const command = process.argv[2] || "summary";

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.error?.message || result.status}`,
    );
  }
  return result;
}

function currentVersion() {
  return packageVersion(root);
}

function validateLocalRelease(version = currentVersion()) {
  return validateSoftwareReleaseArtifacts({
    projectRoot: root,
    version,
    directory: path.join(root, "release", version),
  });
}

function printSummary(release) {
  const installer = release.files[0];
  process.stdout.write(
    [
      "",
      "VERIDIA 软件发布文件摘要",
      `发布版本号：${release.version}`,
      `GitHub Release Tag：v${release.version}`,
      ...release.files.map(
        (file) => `- ${file.name}：${formatArtifactSize(file.size)}`,
      ),
      `安装包 SHA-256：${installer.sha256}`,
      `包含 blockmap：${release.blockmapValid ? "是" : "否"}`,
      `包含 latest.yml：${release.latestValid ? "是" : "否"}`,
      "未执行 rules:publish，未发布远程规则。",
      "",
    ].join("\n"),
  );
}

function requestJson({
  token,
  hostname = "api.github.com",
  method = "GET",
  requestPath,
  body,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = https.request(
      {
        hostname,
        method,
        path: requestPath,
        headers: {
          "User-Agent": "VERIDIA-release-finalizer",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text;
          }
          resolve({ status: response.statusCode, data });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJsonWithRetry(options) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await requestJson(options);
      if (response.status < 500 && response.status !== 429) return response;
      lastError = new Error(`GitHub HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await wait(attempt * 1_000);
  }
  throw lastError;
}

function githubToken() {
  const environmentToken =
    process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  const result = git(["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
  });
  const values = Object.fromEntries(
    result.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  if (!values.password) throw new Error("GitHub credential is unavailable");
  return values.password;
}

function uploadAsset(token, releaseId, asset) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "uploads.github.com",
        method: "POST",
        path: `/repos/${owner}/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
        headers: {
          "User-Agent": "VERIDIA-release-finalizer",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": asset.size,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text;
          }
          if (response.statusCode !== 201) {
            reject(
              new Error(
                `Upload ${asset.name} failed with HTTP ${response.statusCode}`,
              ),
            );
            return;
          }
          resolve(data);
        });
      },
    );
    request.on("error", reject);
    fs.createReadStream(asset.path).on("error", reject).pipe(request);
  });
}

async function headStatus(url, redirects = 6) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request(
      parsed,
      {
        method: "HEAD",
        headers: { "User-Agent": "VERIDIA-release-finalizer" },
      },
      async (response) => {
        response.resume();
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location &&
          redirects > 0
        ) {
          try {
            resolve(
              await headStatus(
                new URL(response.headers.location, parsed).toString(),
                redirects - 1,
              ),
            );
          } catch (error) {
            reject(error);
          }
          return;
        }
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function headStatusWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const status = await headStatus(url);
      if (status === 200) return status;
      lastError = new Error(`HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await wait(attempt * 1_000);
  }
  throw lastError;
}

function scanReleaseSources() {
  const candidates = git(["ls-files", "-co", "--exclude-standard"]).stdout
    .split(/\r?\n/u)
    .filter(Boolean);
  const forbiddenPath =
    /(^|\/)(?:\.env(?:\.(?!example$).*)?|logs|sessions|release|test-results|playwright-report)(\/|$)|\.(?:db|sqlite|sqlite3|log)$/iu;
  const secretPatterns = [
    /-----BEGIN (?:ED25519 |RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/u,
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
    /Bearer\s+[A-Za-z0-9._~-]{24,}/u,
  ];
  for (const relative of candidates) {
    if (forbiddenPath.test(relative)) {
      throw new Error(`Sensitive path cannot be committed: ${relative}`);
    }
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;
    if (fs.statSync(absolute).size > 10 * 1024 * 1024) continue;
    const content = fs.readFileSync(absolute, "utf8");
    if (secretPatterns.some((pattern) => pattern.test(content))) {
      throw new Error(`Sensitive value detected in: ${relative}`);
    }
  }
}

async function lookupRelease(version, token) {
  return requestJsonWithRetry({
    token,
    requestPath: `/repos/${owner}/${repository}/releases/tags/v${version}`,
  });
}

async function verifyRemoteRelease(local, remote, token) {
  const assets = new Map(remote.assets.map((asset) => [asset.name, asset]));
  for (const file of local.files) {
    const asset = assets.get(file.name);
    if (
      !asset ||
      asset.state !== "uploaded" ||
      asset.size !== file.size ||
      asset.digest !== `sha256:${file.sha256}`
    ) {
      throw new Error(`Remote asset verification failed: ${file.name}`);
    }
  }
  const latest = await requestJsonWithRetry({
    token,
    requestPath: `/repos/${owner}/${repository}/releases/latest`,
  });
  if (latest.status !== 200 || latest.data.tag_name !== `v${local.version}`) {
    throw new Error("GitHub Latest Release does not point to this version");
  }
  const base = `https://github.com/${owner}/${repository}/releases/download/v${local.version}`;
  const downloadStatuses = new Map();
  for (const file of local.files) {
    downloadStatuses.set(
      file.name,
      await headStatusWithRetry(`${base}/${encodeURIComponent(file.name)}`),
    );
  }
  if ([...downloadStatuses.values()].some((status) => status !== 200)) {
    throw new Error(
      `匿名下载校验失败：${[...downloadStatuses.entries()]
        .map(([name, status]) => `${name}=${status}`)
        .join("，")}`,
    );
  }
  process.stdout.write(
    [
      `GitHub Release: ${remote.html_url}`,
      `Latest Release: v${local.version}`,
      ...local.files.map((file) => `${file.name}：上传完成，匿名 HTTP 200`),
      `远程安装包 SHA-256：${local.files[0].sha256}`,
      "包含 blockmap：是",
      "包含 latest.yml：是",
      "未执行 rules:publish，未发布远程规则。",
      "",
    ].join("\n"),
  );
}

async function pendingRelease() {
  const local = validateLocalRelease();
  const response = await lookupRelease(local.version, githubToken());
  const tag = `v${local.version}`;
  const remoteTag = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`])
    .stdout.trim();
  if (response.status === 404 && !remoteTag) {
    printSummary(local);
    process.exitCode = 0;
    return;
  }
  process.exitCode = 2;
}

async function triggerActionsRelease() {
  const local = validateLocalRelease();
  printSummary(local);
  scanReleaseSources();
  const tag = `v${local.version}`;
  const token = githubToken();
  const existingRelease = await lookupRelease(local.version, token);
  if (existingRelease.status !== 404) {
    throw new Error(`${tag} 已存在 GitHub Release，拒绝重复发布。`);
  }
  const remoteTag = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`])
    .stdout.trim();
  if (remoteTag) throw new Error(`${tag} 已存在远程 Tag，拒绝重复发布。`);

  const dirty = git(["status", "--short"]).stdout.trim();
  if (dirty) throw new Error("软件发布要求 Git 工作区干净，拒绝自动提交文件。");
  const branch = git(["branch", "--show-current"]).stdout.trim();
  if (branch !== "main") {
    throw new Error("软件正式发布只能从 main 分支触发 GitHub Actions。");
  }
  git(["push", "origin", "main"]);
  const commit = git(["rev-parse", "HEAD"]).stdout.trim();
  const localTag = git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    allowFailure: true,
  });
  if (localTag.status === 0) {
    const taggedCommit = git(["rev-list", "-n", "1", tag]).stdout.trim();
    if (taggedCommit !== commit) {
      throw new Error(`${tag} 已指向其他提交，拒绝覆盖。`);
    }
  } else {
    git(["tag", "-a", tag, "-m", `VERIDIA ${local.version}`]);
  }
  git(["push", "origin", tag]);
  process.stdout.write(
    [
      `已推送 ${tag}，GitHub Actions 将构建并发布 Windows 安装包。`,
      `Actions：https://github.com/${owner}/${repository}/actions/workflows/veridia-release.yml`,
      `Release 完成后地址：https://github.com/${owner}/${repository}/releases/tag/${tag}`,
      "规则仓库未被修改，也没有发布规则新版。",
      "",
    ].join("\n"),
  );
}

async function publishRelease() {
  const local = validateLocalRelease();
  printSummary(local);
  scanReleaseSources();
  git(["add", "-A"]);
  git(["diff", "--cached", "--check"]);
  const staged = git(["diff", "--cached", "--quiet"], { allowFailure: true });
  if (staged.status !== 0) {
    git(["commit", "-m", `release: prepare VERIDIA v${local.version}`]);
  }
  const branch = git(["branch", "--show-current"]).stdout.trim();
  if (!branch) throw new Error("A named Git branch is required");
  git(["push", "origin", branch]);
  const commit = git(["rev-parse", "HEAD"]).stdout.trim();
  const token = githubToken();
  let lookup = await lookupRelease(local.version, token);
  let release;
  if (lookup.status === 404) {
    const created = await requestJson({
      token,
      method: "POST",
      requestPath: `/repos/${owner}/${repository}/releases`,
      body: {
        tag_name: `v${local.version}`,
        target_commitish: commit,
        name: `VERIDIA v${local.version}`,
        body: `## VERIDIA ${local.version}\n\n通过自动检查、测试和 Windows 安装包校验。\n\n本次软件更新包含自动更新所需文件：\n- 安装包 exe\n- blockmap\n- latest.yml\n\n客户端将通过 latest.yml 检测版本，并优先使用 blockmap 进行差分更新。`,
        draft: false,
        prerelease: false,
        make_latest: "true",
      },
    });
    if (created.status !== 201) {
      throw new Error(`Create GitHub Release failed with HTTP ${created.status}`);
    }
    release = created.data;
  } else if (lookup.status === 200) {
    release = lookup.data;
  } else {
    throw new Error(`GitHub Release lookup failed with HTTP ${lookup.status}`);
  }
  const existing = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const file of local.files) {
    const asset = existing.get(file.name);
    if (asset) {
      if (
        asset.size !== file.size ||
        asset.digest !== `sha256:${file.sha256}`
      ) {
        throw new Error(
          `Existing GitHub asset differs; refusing to overwrite: ${file.name}`,
        );
      }
      continue;
    }
    await uploadAsset(token, release.id, file);
  }
  const latestUpdate = await requestJson({
    token,
    method: "PATCH",
    requestPath: `/repos/${owner}/${repository}/releases/${release.id}`,
    body: { make_latest: "true" },
  });
  if (latestUpdate.status !== 200) {
    throw new Error(
      `Setting GitHub Latest Release failed with HTTP ${latestUpdate.status}`,
    );
  }
  lookup = await lookupRelease(local.version, token);
  if (lookup.status !== 200) {
    throw new Error(
      `Published release could not be read anonymously: HTTP ${lookup.status}`,
    );
  }
  await verifyRemoteRelease(local, lookup.data, token);
  git(["fetch", "origin", "tag", `v${local.version}`]);
}

async function verifyPublishedRelease() {
  const version = currentVersion();
  const directoryArgument = process.argv
    .find((value) => value.startsWith("--directory="))
    ?.slice("--directory=".length);
  const local = validateSoftwareReleaseArtifacts({
    projectRoot: root,
    version,
    directory: directoryArgument
      ? path.resolve(root, directoryArgument)
      : path.join(root, "release", version),
  });
  printSummary(local);
  const token = githubToken();
  const lookup = await lookupRelease(version, token);
  if (lookup.status !== 200) {
    throw new Error(`GitHub Release v${version} 不存在或不可读取。`);
  }
  await verifyRemoteRelease(local, lookup.data, token);
}

try {
  if (command === "summary") {
    printSummary(validateLocalRelease());
  } else if (command === "pending") {
    await pendingRelease();
  } else if (command === "publish") {
    await publishRelease();
  } else if (command === "trigger-actions") {
    await triggerActionsRelease();
  } else if (command === "verify-remote") {
    await verifyPublishedRelease();
  } else {
    throw new Error(
      "Expected summary, pending, publish, trigger-actions or verify-remote",
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

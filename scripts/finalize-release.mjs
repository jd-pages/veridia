import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

function sha256(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function currentVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    .version;
}

function validateLocalRelease(version = currentVersion()) {
  const directory = path.join(root, "release", version);
  const installerName = `VERIDIA-Setup-${version}.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const latestName = "latest.yml";
  const files = [installerName, latestName, blockmapName].map((name) => {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing release file: ${filePath}`);
    }
    return {
      name,
      path: filePath,
      size: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    };
  });
  const latest = fs.readFileSync(path.join(directory, latestName), "utf8");
  const latestVersion = latest.match(/^version:\s*(.+)$/mu)?.[1]?.trim();
  const latestPath = latest.match(/^path:\s*(.+)$/mu)?.[1]?.trim();
  const latestSize = Number(
    latest.match(/^\s+size:\s*(\d+)$/mu)?.[1] || Number.NaN,
  );
  const installer = files[0];
  if (
    latestVersion !== version ||
    latestPath !== installerName ||
    latestSize !== installer.size
  ) {
    throw new Error("latest.yml does not match the local installer");
  }
  return { version, directory, files, latestValid: true };
}

function printSummary(release) {
  const installer = release.files[0];
  process.stdout.write(
    [
      "",
      "VERIDIA release artifact summary",
      `Version: ${release.version}`,
      `Installer: ${installer.path}`,
      `Installer size: ${installer.size} bytes`,
      `Installer SHA-256: ${installer.sha256}`,
      `latest.yml validation: ${release.latestValid ? "PASS" : "FAILED"}`,
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

function githubToken() {
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
  return requestJson({
    token,
    requestPath: `/repos/${owner}/${repository}/releases/tags/v${version}`,
  });
}

async function verifyRemoteRelease(local, remote) {
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
  const latest = await requestJson({
    requestPath: `/repos/${owner}/${repository}/releases/latest`,
  });
  if (latest.status !== 200 || latest.data.tag_name !== `v${local.version}`) {
    throw new Error("GitHub Latest Release does not point to this version");
  }
  const base = `https://github.com/${owner}/${repository}/releases/download/v${local.version}`;
  const latestStatus = await headStatusWithRetry(`${base}/latest.yml`);
  const installerStatus = await headStatusWithRetry(
    `${base}/${encodeURIComponent(local.files[0].name)}`,
  );
  if (latestStatus !== 200 || installerStatus !== 200) {
    throw new Error(
      `Anonymous download validation failed: latest=${latestStatus}, installer=${installerStatus}`,
    );
  }
  process.stdout.write(
    [
      `GitHub Release: ${remote.html_url}`,
      `Latest Release: v${local.version}`,
      "latest.yml anonymous HTTP: 200",
      "Installer anonymous HTTP: 200",
      `Remote installer SHA-256: ${local.files[0].sha256}`,
      "",
    ].join("\n"),
  );
}

async function pendingRelease() {
  const local = validateLocalRelease();
  const response = await lookupRelease(local.version);
  if (response.status === 404) {
    printSummary(local);
    process.exitCode = 0;
    return;
  }
  process.exitCode = 2;
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
        body: `## VERIDIA ${local.version}\n\n通过自动检查、测试和 Windows 安装包校验。`,
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
  lookup = await lookupRelease(local.version);
  if (lookup.status !== 200) {
    throw new Error("Published release could not be read anonymously");
  }
  await verifyRemoteRelease(local, lookup.data);
  git(["fetch", "origin", "tag", `v${local.version}`]);
}

try {
  if (command === "summary") {
    printSummary(validateLocalRelease());
  } else if (command === "pending") {
    await pendingRelease();
  } else if (command === "publish") {
    await publishRelease();
  } else {
    throw new Error("Expected summary, pending or publish");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

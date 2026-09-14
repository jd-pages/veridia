import { spawnSync } from "node:child_process";

export const SOURCE_SYNC_MODES = Object.freeze({
  FETCH_VERIFIED: "FETCH_VERIFIED",
  CACHED_ORIGIN_FALLBACK: "CACHED_ORIGIN_FALLBACK",
});

export class LocalPackageGitStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LocalPackageGitStateError";
    this.code = code;
    this.details = details;
  }
}

export function runGitCommand(root, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error,
  };
}

function output(result) {
  return [result.error?.code, result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function requireGit(runGit, root, args, code, message) {
  const result = runGit(root, args);
  if (result.status !== 0 || result.error) {
    throw new LocalPackageGitStateError(
      code,
      `${message}${output(result) ? `：${output(result)}` : ""}`,
      { args, output: output(result) },
    );
  }
  return result.stdout;
}

const NON_NETWORK_FAILURE = /authentication failed|http\s*(401|403)|repository not found|permission denied|access denied|invalid ref|couldn['’]?t find remote ref|bad object|not a git repository|does not appear to be a git repository|remote origin already exists|could not read username/u;
const NETWORK_UNAVAILABLE = /curl\s*28|could not connect to|failed to connect|connection timed out|timed out|connection reset|recv failure|could not resolve host|temporary failure in name resolution|network is unreachable|network unreachable|tls.*(timeout|handshake|connection)|ssl.*(timeout|connection)/u;

export function classifyGitFetchFailure(result) {
  const normalized = output(result).toLowerCase();
  if (NON_NETWORK_FAILURE.test(normalized)) return "NON_NETWORK_FAILURE";
  if (result.error?.code === "ETIMEDOUT" || NETWORK_UNAVAILABLE.test(normalized)) {
    return "NETWORK_UNAVAILABLE";
  }
  return "NON_NETWORK_FAILURE";
}

function assertMainAndClean(root, runGit, operation) {
  const branch = requireGit(
    runGit,
    root,
    ["branch", "--show-current"],
    "GIT_STATE_UNAVAILABLE",
    "无法读取当前 Git 分支",
  );
  if (branch !== "main") {
    throw new LocalPackageGitStateError(
      "BRANCH_NOT_MAIN",
      `${operation}只能从 main 分支执行。`,
      { branch },
    );
  }
  const worktreeStatus = requireGit(
    runGit,
    root,
    ["-c", "core.quotepath=false", "status", "--short"],
    "GIT_STATE_UNAVAILABLE",
    "无法读取 Git 工作区状态",
  );
  if (worktreeStatus) {
    throw new LocalPackageGitStateError(
      "WORKTREE_DIRTY",
      `${operation}要求工作区干净，请先提交或处理以下文件：\n${worktreeStatus}`,
      { worktreeStatus },
    );
  }
  return { branch, worktreeStatus };
}

export function prepareLocalPackageGitState({
  root,
  runGit = runGitCommand,
  fetchTimeoutMs = 10_000,
} = {}) {
  const base = assertMainAndClean(root, runGit, "本地打包");
  const head = requireGit(runGit, root, ["rev-parse", "HEAD"], "GIT_STATE_UNAVAILABLE", "无法读取 HEAD");
  const cachedResult = runGit(root, ["rev-parse", "--verify", "refs/remotes/origin/main"]);
  if (cachedResult.status !== 0 || cachedResult.error || !cachedResult.stdout) {
    throw new LocalPackageGitStateError(
      "CACHED_ORIGIN_MAIN_MISSING",
      "缺少本地缓存 refs/remotes/origin/main，无法证明本地源码与远端 main 一致。",
      { output: output(cachedResult) },
    );
  }
  const cachedOriginMain = cachedResult.stdout;
  const fetchResult = runGit(root, ["fetch", "--quiet", "origin", "main"], { timeoutMs: fetchTimeoutMs });
  if (fetchResult.status === 0 && !fetchResult.error) {
    const originMain = requireGit(runGit, root, ["rev-parse", "origin/main"], "GIT_STATE_UNAVAILABLE", "无法读取 origin/main");
    if (head !== originMain) {
      throw new LocalPackageGitStateError(
        "ORIGIN_MAIN_MISMATCH",
        `HEAD 与实时 origin/main 不一致，本地打包已停止（HEAD ${head} / origin/main ${originMain}）。`,
        { head, originMain },
      );
    }
    return { ...base, head, originMain, mode: SOURCE_SYNC_MODES.FETCH_VERIFIED };
  }
  const failureClassification = classifyGitFetchFailure(fetchResult);
  if (failureClassification !== "NETWORK_UNAVAILABLE") {
    throw new LocalPackageGitStateError(
      "FETCH_FAILED",
      `GitHub 远端校验失败，且不属于可离线降级的网络不可达错误，本地打包已停止${output(fetchResult) ? `：${output(fetchResult)}` : ""}`,
      { classification: failureClassification, output: output(fetchResult) },
    );
  }
  if (head !== cachedOriginMain) {
    throw new LocalPackageGitStateError(
      "ORIGIN_MAIN_MISMATCH",
      `GitHub 当前不可达，且 HEAD 与缓存 origin/main 不一致，本地打包已停止（HEAD ${head} / cached origin/main ${cachedOriginMain}）。`,
      { head, originMain: cachedOriginMain },
    );
  }
  return {
    ...base,
    head,
    originMain: cachedOriginMain,
    mode: SOURCE_SYNC_MODES.CACHED_ORIGIN_FALLBACK,
    fetchFailure: output(fetchResult),
  };
}

export function assertLocalPackageGitState({ state, fullCredential, currentSourceFingerprint } = {}) {
  if (!state || !Object.values(SOURCE_SYNC_MODES).includes(state.mode)) {
    throw new LocalPackageGitStateError("INVALID_PACKAGE_GIT_STATE", "本地打包 Git 校验状态无效。");
  }
  if (state.mode === SOURCE_SYNC_MODES.CACHED_ORIGIN_FALLBACK) {
    if (fullCredential?.commitSha !== state.head) {
      throw new LocalPackageGitStateError(
        "FULL_CREDENTIAL_COMMIT_MISMATCH",
        "GitHub 当前不可达，FULL 凭证 commit 与当前 HEAD 不一致，本地打包已停止。",
        { head: state.head, credentialCommit: fullCredential?.commitSha || null },
      );
    }
    if (!currentSourceFingerprint || fullCredential?.sourceFingerprint !== currentSourceFingerprint) {
      throw new LocalPackageGitStateError(
        "SOURCE_FINGERPRINT_MISMATCH",
        "GitHub 当前不可达，FULL 凭证 source fingerprint 与当前源码不一致，本地打包已停止。",
        { credentialFingerprint: fullCredential?.sourceFingerprint || null, currentSourceFingerprint: currentSourceFingerprint || null },
      );
    }
  }
  return state;
}

export function assertSoftwarePublishGitState({ root, runGit = runGitCommand } = {}) {
  const base = assertMainAndClean(root, runGit, "软件正式发布");
  const fetchResult = runGit(root, ["fetch", "--quiet", "origin", "main"]);
  if (fetchResult.status !== 0 || fetchResult.error) {
    throw new LocalPackageGitStateError(
      "PUBLISH_FETCH_FAILED",
      `软件正式发布必须完成 GitHub 实时校验，git fetch 失败，发布已停止${output(fetchResult) ? `：${output(fetchResult)}` : ""}`,
      { output: output(fetchResult) },
    );
  }
  const head = requireGit(runGit, root, ["rev-parse", "HEAD"], "GIT_STATE_UNAVAILABLE", "无法读取 HEAD");
  const originMain = requireGit(runGit, root, ["rev-parse", "origin/main"], "GIT_STATE_UNAVAILABLE", "无法读取 origin/main");
  if (head !== originMain) {
    throw new LocalPackageGitStateError(
      "ORIGIN_MAIN_MISMATCH",
      `main 与 origin/main 未同步（HEAD ${head} / origin/main ${originMain}），发布已停止。`,
      { ...base, head, originMain },
    );
  }
  return { ...base, head, originMain, mode: SOURCE_SYNC_MODES.FETCH_VERIFIED };
}

export function writeLocalPackageGitState(state, stream = process.stdout) {
  if (state.mode === SOURCE_SYNC_MODES.FETCH_VERIFIED) {
    stream.write("GitHub 远端校验：PASS\nSOURCE_SYNC_MODE=FETCH_VERIFIED\n");
    return;
  }
  stream.write([
    "警告：GitHub 当前不可达",
    "本地 HEAD 与缓存 origin/main 一致",
    "FULL 凭证与当前 HEAD 一致",
    "SOURCE_SYNC_MODE=CACHED_ORIGIN_FALLBACK",
    "GitHub 当前不可达，已使用本地缓存 origin/main + Exact-HEAD FULL 凭证完成离线源码一致性校验。",
    "继续本地打包",
    "",
  ].join("\n"));
}

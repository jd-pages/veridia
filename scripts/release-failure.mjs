export const RELEASE_RESULT_MARKER = "VERIDIA_RELEASE_RESULT=";

export const RELEASE_STAGES = Object.freeze([
  "PREFLIGHT",
  "PREREQUISITE_WARMUP",
  "FULL",
  "LINT",
  "TYPECHECK",
  "UNIT_TEST",
  "E2E",
  "PRODUCTION_BUILD",
  "STANDALONE",
  "DATABASE",
  "SENSITIVE_SCAN",
  "DESKTOP_PREPARE",
  "PACKAGE",
  "INSTALLER_VERIFY",
  "RELEASE_COMMIT",
  "PUSH_MAIN",
  "MAIN_CI",
  "TAG",
  "PUSH_TAG",
  "GITHUB_ACTIONS",
  "GITHUB_RELEASE_CREATED",
  "REMOTE_ASSETS_VERIFY",
  "REMOTE_RELEASE_VERIFY",
  "VERSION_UPDATE",
]);

export const RELEASE_CLASSIFICATIONS = Object.freeze([
  "DETERMINISTIC",
  "DETERMINISTIC_INTEGRITY",
  "TRANSIENT_NETWORK",
  "AUTHENTICATION",
  "TEST_TIMEOUT",
  "FLAKY_CANDIDATE",
  "ENVIRONMENT",
  "STATE_CONFLICT",
  "UNKNOWN",
]);

const ansiPattern = /\u001b\[[0-9;]*m/gu;
const sensitivePattern =
  /((?:token|authorization|password|secret|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/giu;

export function redactReleaseText(value) {
  return String(value || "")
    .replace(ansiPattern, "")
    .replace(sensitivePattern, "$1[REDACTED]")
    .replace(/([?&](?:token|signature|key|auth)=)[^&\s]+/giu, "$1[REDACTED]");
}

export function classifyReleaseFailure(value, fallback = "UNKNOWN") {
  if (
    value &&
    typeof value === "object" &&
    RELEASE_CLASSIFICATIONS.includes(value.classification)
  ) {
    return value.classification;
  }
  const text = redactReleaseText(
    value instanceof Error ? `${value.name} ${value.message} ${value.cause || ""}` : value,
  );
  if (/Test timed out|Timeout of \d+ms exceeded|page\.(?:goto|waitFor).*Timeout/iu.test(text)) {
    return "TEST_TIMEOUT";
  }
  if (
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|TimeoutError|AbortError)\b|schannel|SSL\/TLS connection failed|SSL connect error|TLS (?:handshake )?timeout|failed to receive handshake|Could not resolve host|Failed to connect|Could not connect|Connection timed out|Operation timed out|Recv failure|Send failure|Timeout awaiting ['"](?:request|connect|secureConnect|response)['"] for \d+ms|DNS|TLS handshake|socket hang up|network.*timeout|request.*timeout|Release CDN.*timeout|GitHub HTTP 5\d\d|HTTP 5\d\d/iu.test(
      text,
    )
  ) {
    return "TRANSIENT_NETWORK";
  }
  if (
    /authentication failed|not authenticated|bad credentials|credential.*unavailable|HTTP 401|HTTP 403|permission denied.*publickey|could not read Username|GH_TOKEN.*(?:missing|invalid)|GitHub CLI authentication/iu.test(
      text,
    )
  ) {
    return "AUTHENTICATION";
  }
  if (
    /\b(?:ENOSPC|EACCES|EPERM|EBUSY|ELOCKED)\b|disk space|Temp.*(?:writable|write)|port.*(?:occupied|conflict)|missing.*node|not executable/iu.test(
      text,
    )
  ) {
    return "ENVIRONMENT";
  }
  if (/checksum.*mismatch|integrity.*(?:fail|mismatch)|hash.*mismatch|SHA-?\d+.*(?:fail|mismatch)|digest.*mismatch|artifact.*stale|stale.*artifact/iu.test(text)) {
    return "DETERMINISTIC_INTEGRITY";
  }
  if (
    /Tag .*exists|Release .*exists|version.*conflict|version.*mismatch|main.*diverg|main\/origin|behind remote|not.*ancestor|STATE_CONFLICT|FAILED_RELEASE_TAG|Latest Release.*Latest Historical|Actions.*in_progress|orphan Tag|Tag.*moved|Tag.*overwritten/iu.test(
      text,
    )
  ) {
    return "STATE_CONFLICT";
  }
  if (/Chromium.*(?:timing|filesystem)|EBUSY.*Chromium|browser.*race|flaky candidate/iu.test(text)) {
    return "FLAKY_CANDIDATE";
  }
  if (/browser restart.*deadlock|Runner.*(?:RUNNING|QUEUED).*cascade/iu.test(text)) {
    return "FLAKY_CANDIDATE";
  }
  if (
    /AssertionError|TypeScript.*(?:failed|error)|compile failed|build failed|migration.*failed|Sensitive Scan.*failed|test failed|invalid .*metadata|missing .*asset|missing file-logger|GitHub Actions.*(?:fail|failure)|business assertion/iu.test(
      text,
    )
  ) {
    return "DETERMINISTIC";
  }
  return RELEASE_CLASSIFICATIONS.includes(fallback) ? fallback : "UNKNOWN";
}

export class ReleaseStageError extends Error {
  constructor(input, options = {}) {
    const safeSummary = redactReleaseText(input.summary || "发布阶段失败")
      .trim()
      .slice(0, 1_200);
    super(safeSummary, options.cause ? { cause: options.cause } : undefined);
    this.name = "ReleaseStageError";
    this.stage = input.stage || "FULL";
    this.classification = input.classification || classifyReleaseFailure(input.summary);
    this.command = input.command;
    this.summary = safeSummary;
    this.detailLog = input.detailLog;
    this.target = input.target;
    this.failedItem = input.failedItem;
    this.attempt = input.attempt;
    this.maxAttempts = input.maxAttempts;
    this.elapsedMs = input.elapsedMs;
    this.cacheStatus = input.cacheStatus;
    this.checkpoint = input.checkpoint;
    this.recoveryPoint = input.recoveryPoint;
    this.sideEffects = input.sideEffects;
    this.versionConsumed = input.versionConsumed;
    this.recovery = input.recovery;
    this.code = input.code || "RELEASE_STAGE_FAILED";
  }
}

export function releaseFailureResult(error, fallback = {}) {
  const source = error instanceof ReleaseStageError ? error : null;
  const summary = redactReleaseText(
    source?.summary || (error instanceof Error ? error.message : String(error)),
  )
    .trim()
    .slice(0, 1_200);
  return {
    success: false,
    stage: source?.stage || fallback.stage || "FULL",
    classification:
      source?.classification ||
      fallback.classification ||
      classifyReleaseFailure(summary),
    command: redactReleaseText(source?.command || fallback.command || "").trim() || undefined,
    summary,
    detailLog: source?.detailLog || fallback.detailLog,
    target: redactReleaseText(source?.target || fallback.target || "").trim() || undefined,
    failedItem:
      redactReleaseText(source?.failedItem || fallback.failedItem || "").trim() || undefined,
    attempt: source?.attempt || fallback.attempt,
    maxAttempts: source?.maxAttempts || fallback.maxAttempts,
    elapsedMs: source?.elapsedMs ?? fallback.elapsedMs,
    cacheStatus:
      redactReleaseText(source?.cacheStatus || fallback.cacheStatus || "").trim() ||
      undefined,
    checkpoint: source?.checkpoint || fallback.checkpoint,
    recoveryPoint: source?.recoveryPoint || fallback.recoveryPoint,
    sideEffects: source?.sideEffects ?? fallback.sideEffects,
    versionConsumed: source?.versionConsumed ?? fallback.versionConsumed,
    recovery: redactReleaseText(source?.recovery || fallback.recovery || "").trim() || undefined,
  };
}

export function releaseResultLine(error, fallback) {
  return `${RELEASE_RESULT_MARKER}${JSON.stringify(releaseFailureResult(error, fallback))}`;
}

export function parseReleaseResult(value) {
  const lines = String(value || "").split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const position = lines[index].indexOf(RELEASE_RESULT_MARKER);
    if (position < 0) continue;
    try {
      const parsed = JSON.parse(lines[index].slice(position + RELEASE_RESULT_MARKER.length));
      if (parsed && parsed.success === false && parsed.stage && parsed.classification) {
        return parsed;
      }
    } catch {
      // Ignore malformed child output and let the caller use a safe fallback.
    }
  }
  return null;
}

function firstMatch(text, pattern) {
  return redactReleaseText(text).match(pattern)?.[1]?.trim();
}

export function inferVerifyFailure(output, detailLog) {
  const plain = redactReleaseText(output);
  const marker = plain.match(/VERIDIA_VERIFY_RESULT=(\{[^\r\n]+\})/u);
  let verification = null;
  let failures = [];
  if (marker) {
    try {
      verification = JSON.parse(marker[1]);
      failures = verification.failures || [];
    } catch {
      failures = [];
    }
  }
  const first = failures[0] || "FULL";
  const stage = first.startsWith("All unit tests")
    ? "UNIT_TEST"
    : first === "Lint"
      ? "LINT"
      : first === "Typecheck"
        ? "TYPECHECK"
        : first.startsWith("E2E ")
          ? "E2E"
          : first === "Production build"
            ? "PRODUCTION_BUILD"
            : first === "Standalone runtime"
              ? "STANDALONE"
              : first === "Database compatibility"
                ? "DATABASE"
                : first === "Sensitive scan"
                  ? "SENSITIVE_SCAN"
                  : "FULL";
  const failedTest = firstMatch(
    plain,
    /(?:FAIL|\u00d7)\s+([^\r\n]+?(?:\.test\.[cm]?[jt]sx?[^\r\n]*|\.spec\.[cm]?[jt]sx?[^\r\n]*))/iu,
  );
  const timeout = firstMatch(plain, /(Test timed out in \d+ms|Timeout \d+ms exceeded)/iu);
  const structuredFailure = verification?.firstFailure;
  const summary =
    structuredFailure?.summary ||
    timeout ||
    firstMatch(plain, /(?:Error|AssertionError):\s*([^\r\n]+)/iu) ||
    `${first} failed`;
  return new ReleaseStageError({
    stage,
    classification:
      structuredFailure?.classification || classifyReleaseFailure(summary),
    command: "npm.cmd run verify:full",
    summary,
    failedItem: structuredFailure?.failedItem || failedTest || first,
    detailLog,
  });
}

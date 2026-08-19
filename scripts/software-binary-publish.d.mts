export interface BinaryReleaseStep {
  name: string;
  conclusion: string;
}

export interface BinaryReleaseRun {
  version: string;
  headSha: string;
  headBranch: string;
  conclusion: string;
  jobs?: Array<{ steps?: BinaryReleaseStep[] }>;
}

export interface BinaryReleaseFileIdentity {
  name: string;
  size: number;
  sha256: string;
  sha512?: string;
}

export interface BinaryReleaseAsset {
  name: string;
  size: number;
  digest?: string;
  state?: string;
}

export interface BinaryDraftRelease {
  draft: boolean;
  prerelease: boolean;
  assets?: BinaryReleaseAsset[];
}

export interface BinaryArtifactManifest {
  files?: BinaryReleaseFileIdentity[];
  [key: string]: unknown;
}

export function classifyBinaryResumeRun(
  run: BinaryReleaseRun,
  tagCommit: string,
): "BINARY_PUBLISH_READY" | "BINARY_PUBLISH_RECOVERABLE";
export function planBinaryResumeAssets(
  release: BinaryDraftRelease,
  manifest: BinaryArtifactManifest,
): { reuse: string[]; upload: string[] };
export function createRecoveredArtifactManifest(input: {
  projectRoot: string;
  version: string;
  directory: string;
  tagCommit: string;
  runId: number | string;
}): BinaryArtifactManifest;
export function verifyReleaseAssetDigests(
  release: BinaryDraftRelease,
  validation: { files: BinaryReleaseFileIdentity[] },
): true;
export function runBinaryPublish(): Promise<void>;

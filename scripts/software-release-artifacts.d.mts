export interface SoftwareReleaseArtifact {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  sha512: string;
}

export interface SoftwareReleaseValidation {
  version: string;
  directory: string;
  files: SoftwareReleaseArtifact[];
  installerSha256: string;
  installerSha512: string;
  mode: "LOCAL_BUILD" | "REMOTE_DOWNLOAD";
  manifestValid: boolean;
  latestValid: true;
  blockmapValid: true;
}

export const SOFTWARE_RELEASE_VALIDATION_MODES: Readonly<{
  LOCAL_BUILD: "LOCAL_BUILD";
  REMOTE_DOWNLOAD: "REMOTE_DOWNLOAD";
}>;
export function hashSoftwareReleaseFile(
  filePath: string,
  algorithm: string,
  encoding: "hex" | "base64",
): string;
export function softwareReleaseArtifactNames(version: string): string[];
export function packageVersion(projectRoot: string): string;
export function validateSoftwareReleaseArtifacts(options: {
  projectRoot: string;
  version?: string;
  directory?: string;
  mode?: "LOCAL_BUILD" | "REMOTE_DOWNLOAD";
  manifest?: Record<string, unknown>;
  manifestPath?: string;
  expectedTagCommit?: string;
  expectedSourceFingerprint?: string;
}): SoftwareReleaseValidation;
export function formatArtifactSize(bytes: number): string;
export function collectReleaseSourceFingerprint(projectRoot: string): string;
export function collectGitRevisionSourceFingerprint(
  projectRoot: string,
  revision: string,
): string;
export function artifactManifestPath(projectRoot: string, version: string): string;
export function writeReleaseArtifactManifest(options: {
  projectRoot: string;
  version?: string;
  directory?: string;
  buildTimestamp?: string;
  tagCommit?: string | null;
  outputPath?: string;
  validation?: SoftwareReleaseValidation;
}): Record<string, unknown>;
export function bindArtifactManifestToReleaseCommit(
  projectRoot: string,
  version: string,
  releaseCommit: string,
): Record<string, unknown>;
export function validateReleaseArtifactManifest(options: {
  projectRoot: string;
  version?: string;
  currentHead?: string;
}): {
  status: string;
  valid: boolean;
  reasons: string[];
  manifest?: Record<string, unknown>;
  sourceFingerprint?: string;
};

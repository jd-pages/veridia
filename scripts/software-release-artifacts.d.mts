export interface SoftwareReleaseArtifact {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface SoftwareReleaseValidation {
  version: string;
  directory: string;
  files: SoftwareReleaseArtifact[];
  installerSha256: string;
  latestValid: true;
  blockmapValid: true;
}

export function softwareReleaseArtifactNames(version: string): string[];

export function packageVersion(projectRoot: string): string;

export function validateSoftwareReleaseArtifacts(options: {
  projectRoot: string;
  version?: string;
  directory?: string;
}): SoftwareReleaseValidation;

export function formatArtifactSize(bytes: number): string;

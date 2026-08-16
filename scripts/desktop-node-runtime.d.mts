export interface DesktopNodeRuntimeRequirements {
  version: string;
  versionTag: string;
  platform: "win32";
  architecture: "x64";
  archiveName: string;
  archiveSha256: string;
  executableSha256: string;
  distributionRoot: string;
}

export interface DesktopNodeRuntimeInspection {
  valid: boolean;
  reason: string;
  executablePath: string;
  version: string | null;
  sha256: string | null;
}

export const DESKTOP_NODE_RUNTIME: Readonly<DesktopNodeRuntimeRequirements>;

export function inspectDesktopNodeRuntime(input: {
  destinationRoot: string;
  requirements?: DesktopNodeRuntimeRequirements;
  platform?: NodeJS.Platform;
  architecture?: string;
  runVersion?: (executable: string) => string;
}): DesktopNodeRuntimeInspection;

export function prepareDesktopNodeRuntime(input: {
  projectRoot: string;
  destinationRoot?: string;
  requirements?: DesktopNodeRuntimeRequirements;
  platform?: NodeJS.Platform;
  architecture?: string;
  runVersion?: (executable: string) => string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  output?: (message: string) => void;
}): Promise<DesktopNodeRuntimeInspection & { source: "EXISTING" | "DOWNLOAD" }>;

export function assertDesktopNodeRuntime(input: {
  destinationRoot: string;
  requirements?: DesktopNodeRuntimeRequirements;
  platform?: NodeJS.Platform;
  architecture?: string;
  runVersion?: (executable: string) => string;
}): DesktopNodeRuntimeInspection & { valid: true };

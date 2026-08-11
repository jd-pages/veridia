export interface PlaywrightChromiumRequirements {
  playwrightVersion: string;
  revision: string;
  browserVersion: string | null;
  directoryName: string;
  headlessShellRevision: string | null;
}

export interface ChromiumCacheInspection {
  valid: boolean;
  reason: string;
  cacheRoot: string;
  browserDirectory: string;
  executablePath: string | null;
}

export const MINIMUM_CHROMIUM_FILE_SIZES: Readonly<Record<string, number>>;

export function readPlaywrightChromiumRequirements(
  projectRoot: string,
): PlaywrightChromiumRequirements;

export function trustedPlaywrightCacheRoots(input: {
  projectRoot: string;
  destinationRoot: string;
  environment?: NodeJS.ProcessEnv;
}): string[];

export function resolvePlaywrightChromiumExecutable(
  projectRoot: string,
  browserRoot: string,
): string;

export function inspectChromiumCache(input: {
  cacheRoot: string;
  requirements: PlaywrightChromiumRequirements;
  projectRoot: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  minimumFileSizes?: Record<string, number>;
  resolveExecutable?: (projectRoot: string, browserRoot: string) => string;
}): ChromiumCacheInspection;

export function preparePlaywrightChromiumRuntime(input: {
  projectRoot: string;
  destinationRoot: string;
  cacheRoots?: string[];
  requirements?: PlaywrightChromiumRequirements;
  download?: (downloadRoot: string) => void;
  output?: (message: string) => void;
  platform?: NodeJS.Platform;
  architecture?: string;
  minimumFileSizes?: Record<string, number>;
  resolveExecutable?: (projectRoot: string, browserRoot: string) => string;
}): {
  source: "CACHE" | "DOWNLOAD";
  requirements: PlaywrightChromiumRequirements;
  cacheRoot: string;
  destinationRoot: string;
  executablePath: string;
  elapsedMs: number;
  diagnostics: ChromiumCacheInspection[];
};

export function assertPlaywrightChromiumRuntime(input: {
  projectRoot: string;
  browserRoot: string;
  requirements?: PlaywrightChromiumRequirements;
  platform?: NodeJS.Platform;
  architecture?: string;
  minimumFileSizes?: Record<string, number>;
  resolveExecutable?: (projectRoot: string, browserRoot: string) => string;
}): ChromiumCacheInspection & {
  valid: true;
  executablePath: string;
  requirements: PlaywrightChromiumRequirements;
};

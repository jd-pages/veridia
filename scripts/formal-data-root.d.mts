export interface FormalDataRootOptions {
  environment?: Record<string, string | undefined>;
  controlRoot?: string;
  homeDirectory?: string;
}

export function defaultVeridiaControlRoot(
  options?: Omit<FormalDataRootOptions, "controlRoot">,
): string;
export function resolveFormalDataRoot(options?: FormalDataRootOptions): string;

export const TODAY_STABILITY_REGRESSION_PACK: ReadonlyArray<{ key: string; unit: string[]; e2e: string[] }>;
export function stabilityPackSelection(root?: string): { categories: string[]; unitFiles: string[]; e2eGroups: Array<{ name: string; files: string[]; workers: number }>; retries: number };
export function actualE2eSummary(output: string): null | { total: number; executed: number; passed: number; failed: number; notRun: number; passedAll: boolean };
export function sanitizeStabilityOutput(output: string, secrets?: Array<string | undefined>): string;
export function runStabilityPack(args?: string[], root?: string): Promise<unknown>;

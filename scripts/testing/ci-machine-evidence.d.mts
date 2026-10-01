export type CiMachineProjection = Record<string, unknown> & { measurement: "AVAILABLE" | "NOT_RUN" };
export type CiVerificationContext = { source: "GITHUB_ACTIONS" | "SYNTHETIC_UNIT_TEST"; runId: string; runAttempt: number; sha: string; job: string };
export function readGitHubVerificationContext(env?: Record<string, string | undefined>): CiVerificationContext;
export function beginCiVerificationWindow(options: { root?: string; mode: "affected" | "full"; context: CiVerificationContext; now?: () => Date }): {
  relativePath: string; marker: { schemaVersion: number; purpose: string; mode: string; context: CiVerificationContext; startedAt: string; nonce: string };
};
export function projectVerificationEvidence(input: unknown, secrets?: string[]): CiMachineProjection;
export function projectVitestEvidence(input: unknown, secrets?: string[]): CiMachineProjection;
export function projectPlaywrightEvidence(input: unknown, secrets?: string[]): CiMachineProjection;
export function projectOwnedRunEvidence(input: unknown, secrets?: string[]): CiMachineProjection;
export function validateOwnedRunEvidence(run: CiMachineProjection, native: CiMachineProjection): { status: "PASSED" | "FAILED" | "NOT_RUN"; issues: string[] };
export function exportCiMachineEvidence(options: { root?: string; mode: "affected" | "full"; context?: CiVerificationContext; secrets?: string[] }): {
  status: "PASSED" | "FAILED" | "NOT_RUN"; outputDirectory: string;
  index: { status: "PASSED" | "FAILED" | "NOT_RUN"; issues: string[]; files: { path: string; source: unknown }[]; ownedRuns: { runId: string; group: string; status: string; issues: string[] }[];
    unitEvidence: { selection: "SELECTED" | "NOT_SELECTED"; reportCount: number; actualTotal: number } };
};

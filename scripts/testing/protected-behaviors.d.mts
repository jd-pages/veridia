export interface ProtectedBehavior {
  key: string;
  module: string;
  invariant: string;
  unitTests: readonly string[];
  e2eTests: readonly string[];
  unitCases: readonly { file: string; title: string }[];
  e2eCases: readonly { file: string; title: string }[];
  fixtures: readonly string[];
  triggerFiles: readonly string[];
  protectedExpectation: true;
  expectationChangePolicy: string;
}

export interface ProtectedSelection {
  behaviorKeys: string[];
  groups: string[];
  unitTests: string[];
  e2eTests: string[];
  reasons: string[];
}

export const PROTECTED_EXPECTATION_CHANGE_POLICY: string;
export const PROTECTED_BEHAVIORS: readonly ProtectedBehavior[];
export const PROTECTED_BEHAVIOR_GROUPS: Readonly<Record<string, readonly string[]>>;
export const CHANGE_IMPACT_MAP: readonly Readonly<{ match: RegExp; groups: readonly string[]; reason: string }>[];
export function selectProtectedBehaviors(changedFiles: string[], options?: { full?: boolean; conservative?: boolean }): ProtectedSelection;
export function validateProtectedBehaviorRegistry(root?: string): { behaviorCount: number; groupCount: number; keys: string[] };

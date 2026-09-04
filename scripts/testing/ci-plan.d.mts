import type { ChangeRisk } from "./test-matrix.mjs";

export interface AffectedCiPlan {
  mode: "affected";
  risk: ChangeRisk;
  unitFiles: string[];
  unitRelatedFiles: string[];
  e2eFiles: string[];
  needsBrowser: boolean;
}

export function createAffectedCiPlan(changedFiles: string[], recoveryGroup?: string): AffectedCiPlan;

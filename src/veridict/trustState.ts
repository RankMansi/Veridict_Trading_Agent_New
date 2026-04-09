/**
 * VERIDICT — trust degradation (DISABLED for local study)
 *
 * `src/agent/index.ts` does not import this module while studying.
 */

/*
let delegationGapViolations = 0;

export function recordDelegationGapHardBlock(): void {
  delegationGapViolations += 1;
}

export function getDelegationGapViolations(): number {
  return delegationGapViolations;
}

export type TrustLevel = "High" | "Medium" | "Low" | "Frozen";

export function getTrustLevel(): TrustLevel {
  if (delegationGapViolations >= 8) return "Frozen";
  if (delegationGapViolations >= 5) return "Low";
  if (delegationGapViolations >= 2) return "Medium";
  return "High";
}

export function effectiveMaxTradeUsd(baseMax: number): number {
  const lvl = getTrustLevel();
  if (lvl === "Frozen") return 0;
  if (lvl === "Low") return baseMax * 0.4;
  if (lvl === "Medium") return baseMax * 0.7;
  return baseMax;
}
*/

export type TrustLevel = "High" | "Medium" | "Low" | "Frozen";

export function recordDelegationGapHardBlock(): void {}

export function getDelegationGapViolations(): number {
  return 0;
}

export function getTrustLevel(): TrustLevel {
  return "High";
}

export function effectiveMaxTradeUsd(baseMax: number): number {
  return baseMax;
}

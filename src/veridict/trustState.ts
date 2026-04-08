/**
 * VERIDICT — trust degradation after mechanical gate hard-blocks (Delegation Gap signal).
 * Full SAE metrics live in the Python stack; this mirrors the leash tightening idea.
 */

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

/** Scale policy max trade USD by trust (High 100%, Medium −30%, Low −60%, Frozen 0). */
export function effectiveMaxTradeUsd(baseMax: number): number {
  const lvl = getTrustLevel();
  if (lvl === "Frozen") return 0;
  if (lvl === "Low") return baseMax * 0.4;
  if (lvl === "Medium") return baseMax * 0.7;
  return baseMax;
}

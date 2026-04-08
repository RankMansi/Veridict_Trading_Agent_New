/**
 * VERIDICT — Delegation Gap Sentinel (mechanical layer, template subset).
 * Hard blocks are non-bypassable; soft flags feed the tribunal stub.
 */

import type { TradeDecision } from "../types/index";
import { effectiveMaxTradeUsd, getTrustLevel } from "./trustState";

export interface GateResult {
  hardBlock: boolean;
  softFlags: string[];
  findings: string[];
}

export interface PolicyOptions {
  allowedPairs: Set<string>;
  maxTradeUsd: number;
}

const DEFAULT_PAIRS = ["BTCUSD", "XBTUSD", "XXBTZUSD", "ETHUSD", "XETHZUSD"];

export function loadPolicyFromEnv(): PolicyOptions {
  const raw = process.env.POLICY_ALLOWED_PAIRS?.trim();
  const pairs = raw
    ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_PAIRS;
  const maxRaw = process.env.POLICY_MAX_TRADE_USD?.trim();
  const baseMax = maxRaw ? parseFloat(maxRaw) : 500;
  const maxTradeUsd = Number.isFinite(baseMax) && baseMax > 0 ? baseMax : 500;
  return { allowedPairs: new Set(pairs), maxTradeUsd };
}

export function runDelegationGapSentinel(
  decision: TradeDecision,
  policy: PolicyOptions
): GateResult {
  const findings: string[] = [];
  const softFlags: string[] = [];
  const maxUsd = effectiveMaxTradeUsd(policy.maxTradeUsd);

  const pairOk = policy.allowedPairs.has(decision.pair);
  if (!pairOk) {
    findings.push(`HARD: pair "${decision.pair}" not in policy allowlist`);
    return { hardBlock: true, softFlags, findings };
  }

  if (decision.action !== "HOLD" && decision.amount > maxUsd) {
    findings.push(
      `HARD: proposed $${decision.amount.toFixed(2)} exceeds effective policy cap $${maxUsd.toFixed(2)} (trust-adjusted)`
    );
    return { hardBlock: true, softFlags, findings };
  }

  if (getTrustLevel() === "Frozen" && decision.action !== "HOLD") {
    findings.push("HARD: Trust State Frozen — no trades until reset");
    return { hardBlock: true, softFlags, findings };
  }

  if (decision.confidence < 0.35 && decision.action !== "HOLD") {
    softFlags.push("LOW_CONFIDENCE");
    findings.push(
      `SOFT: confidence ${(decision.confidence * 100).toFixed(0)}% — tribunal considers elevated discretion risk`
    );
  }

  return { hardBlock: false, softFlags, findings };
}

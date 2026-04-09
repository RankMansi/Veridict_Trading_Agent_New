/**
 * Main agent loop — ERC-8004 + Kraken (+ optional VERIDICT mechanical layer)
 *
 * STUDY MODE: `src/veridict/*` is disabled — no imports from that folder. Strategy → router → checkpoint only.
 * Re-enable VERIDICT: restore imports below from `../veridict/policyGate`, `trustState`, `tribunalStub` and the tick block marked in comments.
 *
 * Each tick:
 *   1. Fetch market data (Kraken CLI, or public REST fallback if CLI missing / KRAKEN_USE_REST)
 *   2. Strategy.analyze(market) → TradeDecision (MomentumStrategy by default — swap in index.ts)
 *   3. (off) Delegation Gap + tribunal — see `src/veridict/` when re-enabled
 *   4. Format human-readable explanation
 *   5. If BUY/SELL:
 *      a. Build + sign TradeIntent (EIP-712, agentWallet)
 *      b. Submit TradeIntent to RiskRouter — get approval/rejection on-chain
 *      c. If approved: execute via Kraken CLI
 *   6. Generate EIP-712 signed checkpoint (includes intentHash)
 *   7. Optionally post to ValidationRegistry (default on; POST_VALIDATION_ATTESTATION=false to disable)
 *   8. Append checkpoint to checkpoints.jsonl
 *
 * Swap strategy: edit the strategy block at the bottom of this file.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

import { TradingStrategy } from "../types/index";
import { getAgentId, getAgentRegistration } from "./identity";
import { MomentumStrategy } from "./strategy";
import { KrakenClient } from "../exchange/kraken";
import { VaultClient } from "../onchain/vault";
import { RiskRouterClient } from "../onchain/riskRouter";
import { ValidationRegistryClient } from "../onchain/validationRegistry";
import { formatExplanation, formatCheckpointLog } from "../explainability/reasoner";
import { generateCheckpoint } from "../explainability/checkpoint";
// VERIDICT (study mode off): import { loadPolicyFromEnv, runDelegationGapSentinel, type GateResult } from "../veridict/policyGate";
// VERIDICT (study mode off): import { recordDelegationGapHardBlock, getTrustLevel, getDelegationGapViolations } from "../veridict/trustState";
// VERIDICT (study mode off): import { oracleTribunalVerdict } from "../veridict/tribunalStub";

/** Minimal shape for ValidationRegistry attestation notes when VERIDICT imports are disabled. */
interface GateResultStub {
  hardBlock: boolean;
  softFlags: string[];
  findings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SEPOLIA_CHAIN_ID = 11155111;
const TRADING_PAIR    = process.env.TRADING_PAIR || "BTCUSD";
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || "30000");
const CHECKPOINTS_FILE = path.join(process.cwd(), "checkpoints.jsonl");
const HOLD_INTENT_HASH = ethers.ZeroHash; // used for HOLD decisions (no intent submitted)

/** Env flag: default `true` when unset; set POST_VALIDATION_ATTESTATION=false to save gas or if posting reverts. */
function envFlag(key: string, defaultWhenUnset: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || String(v).trim() === "") return defaultWhenUnset;
  const t = String(v).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(t)) return false;
  if (["true", "1", "yes", "on"].includes(t)) return true;
  return defaultWhenUnset;
}

/** Post EIP-712 attestations so ValidationRegistry averages move (operator pays gas). */
const POST_VALIDATION_ATTESTATION = envFlag("POST_VALIDATION_ATTESTATION", true);
/** When true, HOLD checkpoints are not attested (saves gas). Default false — attest HOLD too (attestation notes show study vs full VERIDICT). */
const POST_VALIDATION_SKIP_HOLD = envFlag("POST_VALIDATION_SKIP_HOLD", false);

/** eth_call simulateIntent before submitTradeIntent — avoids gas on risk rejections (default on) */
const PREFLIGHT_SIMULATE_INTENT = process.env.HACKATHON_PREFLIGHT_SIMULATE !== "false";

/**
 * RiskRouter does not require msg.sender == agentWallet; operator can pay gas while agent only signs.
 * Set RISK_ROUTER_GAS_PAYER=agent to use the hot wallet for submits (must be funded).
 */
function routerGasSigner(operator: ethers.Wallet, agent: ethers.Wallet): ethers.Wallet {
  return process.env.RISK_ROUTER_GAS_PAYER === "agent" ? agent : operator;
}

/** 0–100 posted if self-attest enabled; default 100. Set AGENT_VALIDATION_SCORE=auto for confidence×100 */
function agentValidationScoreForPost(decision: { confidence: number }): number {
  const raw = (process.env.AGENT_VALIDATION_SCORE ?? "100").trim().toLowerCase();
  if (raw === "auto") {
    return Math.max(0, Math.min(100, Math.round(decision.confidence * 100)));
  }
  const n = parseInt(raw, 10);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  return 100;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

/** ValidationRegistry `notes`: risk subsystem summary for judges / explorers (length-capped for gas). */
function buildValidationAttestationNotes(
  decision: { action: string; pair: string; reasoning: string },
  market: { price: number },
  gate: GateResultStub,
  tribunalRecord: string,
  trustLevel: string,
  dgViolations: number,
  intentHash: string
): string {
  const maxRaw = process.env.VALIDATION_ATTESTATION_NOTES_MAX?.trim();
  const maxLen = Math.min(2048, Math.max(200, parseInt(maxRaw || "900", 10) || 900));
  const findings = gate.findings.length ? gate.findings.join("; ") : "none";
  const soft = gate.softFlags.length ? gate.softFlags.join(",") : "—";
  let routerLeg = "";
  const r = decision.reasoning;
  if (r.includes("[BLOCKED by RiskRouter:")) routerLeg = " | RiskRouter=REJECTED";
  else if (r.includes("[RiskRouter preflight:")) routerLeg = " | RiskRouter_preflight=REJECTED";
  else if (decision.action !== "HOLD" && intentHash !== HOLD_INTENT_HASH) routerLeg = " | RiskRouter=APPROVED+intent";
  else if (decision.action === "HOLD") routerLeg = " | noTradeIntent";

  let s =
    `[risk] ${decision.action} ${decision.pair} @$${market.price} | ` +
    `trust=${trustLevel} dgSignals=${dgViolations} | ` +
    `gate hard=${gate.hardBlock} soft=[${soft}] | findings: ${findings} | ` +
    `tribunal: ${tribunalRecord}${routerLeg}`;
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + "...";
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgent(strategy: TradingStrategy) {
  const rpcUrl           = requireEnv("SEPOLIA_RPC_URL");
  const privateKey       = requireEnv("PRIVATE_KEY");
  const registryAddress  = requireEnv("AGENT_REGISTRY_ADDRESS");
  const vaultAddress     = requireEnv("HACKATHON_VAULT_ADDRESS");
  const routerAddress    = requireEnv("RISK_ROUTER_ADDRESS");
  const validationAddress = requireEnv("VALIDATION_REGISTRY_ADDRESS");

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // operatorWallet: owns the ERC-721 token
  const operatorSigner = new ethers.Wallet(privateKey, provider);

  // agentWallet: hot wallet for signing TradeIntents + checkpoints
  // If AGENT_WALLET_PRIVATE_KEY is set, use a separate hot wallet; else reuse operator
  const agentWalletKey = process.env.AGENT_WALLET_PRIVATE_KEY || privateKey;
  const agentWallet = new ethers.Wallet(agentWalletKey, provider);

  const agentName = (process.env.AGENT_NAME || "VERIDICT").trim();
  const agentDesc = (
    process.env.AGENT_DESCRIPTION ||
    "VERIDICT: verifiable autonomous trading — policy-bound decisions, EIP-712 checkpoints, ERC-8004 identity (full tribunal + IPFS chain in Python stack)."
  ).trim();
  const agentCaps = (process.env.AGENT_CAPABILITIES || "trading,veridict,eip712-signing,explainability,delegation-gap-sentinel")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Resolve agent identity (registers ERC-721 on first run)
  const agentId = await getAgentId(operatorSigner, registryAddress, {
    name: agentName,
    description: agentDesc,
    capabilities: agentCaps.length ? agentCaps : ["trading", "eip712-signing"],
    agentWallet: agentWallet.address,
    agentURI: `data:application/json,${encodeURIComponent(JSON.stringify({
      name: agentName,
      description: agentDesc,
      capabilities: agentCaps,
      agentWallet: agentWallet.address,
      version: "1.0.0",
    }))}`,
  });

  // Fetch registration to confirm agentWallet
  const reg = await getAgentRegistration(provider, registryAddress, agentId);
  console.log(`[agent] agentWallet: ${reg.agentWallet}`);

  // Init clients
  const kraken = new KrakenClient();
  const vault = new VaultClient(vaultAddress, provider);
  const routerSubmitter = routerGasSigner(operatorSigner, agentWallet);
  const riskRouter = new RiskRouterClient(routerAddress, routerSubmitter, SEPOLIA_CHAIN_ID);
  const validation = new ValidationRegistryClient(validationAddress, operatorSigner);

  console.log(
    `\n[veridict] STUDY MODE: src/veridict not applied — strategy output goes straight to RiskRouter/checkpoints (re-enable imports in index.ts to restore gate + tribunal).`
  );
  console.log(
    `[veridict] Checkpoints: EIP-712 → checkpoints.jsonl; ValidationRegistry uses operator wallet when POST_VALIDATION_ATTESTATION is on.\n`
  );

  console.log(`[agent] RiskRouter gas payer: ${routerSubmitter.address} (set RISK_ROUTER_GAS_PAYER=agent to use hot wallet)`);
  console.log(`[agent] Intent signer (EIP-712): ${agentWallet.address}`);
  console.log(`[agent] Preflight simulate: ${PREFLIGHT_SIMULATE_INTENT} (HACKATHON_PREFLIGHT_SIMULATE=false to disable)`);
  if (!POST_VALIDATION_ATTESTATION) {
    console.log(`[agent] ValidationRegistry self-post: off (set POST_VALIDATION_ATTESTATION=true to update on-chain averages)\n`);
  } else {
    console.log(
      `[agent] ValidationRegistry: ON — operator ${operatorSigner.address} posts EIP-712 attestations (score=${process.env.AGENT_VALIDATION_SCORE ?? "100"} or auto; HOLD ${POST_VALIDATION_SKIP_HOLD ? "skipped" : "included"}; notes: study-mode stubs for gate/tribunal).\n`
    );
    console.log(
      `[agent] ReputationRegistry: operators cannot self-rate — reputation moves via judges / external submitFeedback only.\n`
    );
  }

  console.log(`[agent] Starting agent loop`);
  console.log(`[agent] agentId:  ${agentId}`);
  console.log(`[agent] Pair:     ${TRADING_PAIR}`);
  console.log(`[agent] Interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`[agent] Checkpoints: ${CHECKPOINTS_FILE}\n`);

  // ─────────────────────────────────────────────────────────────────────────
  // Main tick (serialized — prevents interleaved console output if a tick overruns POLL_INTERVAL)
  // ─────────────────────────────────────────────────────────────────────────

  let tickBusy = false;

  const tick = async () => {
    if (tickBusy) {
      console.warn(`[agent] Skipping tick: previous tick still running (increase POLL_INTERVAL_MS if this repeats)`);
      return;
    }
    tickBusy = true;
    try {
      // 1. Fetch market data via Kraken CLI
      const market = await kraken.getTicker(TRADING_PAIR);
      console.log(`[agent] ${TRADING_PAIR} @ $${market.price.toLocaleString()}`);

      // 2. Strategy decision
      let decision = await strategy.analyze(market);

      // 3–4. VERIDICT — disabled for study (restore block from git / uncomment imports + policy + gate/tribunal)
      const gate: GateResultStub = { hardBlock: false, softFlags: [], findings: [] };
      const trustLevel = "—";
      const dgViolations = 0;
      const tribunal = { record: "VERIDICT layer disabled (study mode)", execute: true as const };
      console.log(`[veridict] ${tribunal.record}`);

      /*
      const policy = loadPolicyFromEnv();
      const gate = runDelegationGapSentinel(decision, policy);
      const trustLevel = getTrustLevel();
      const dgViolations = getDelegationGapViolations();
      console.log(
        `[veridict] Trust=${trustLevel} DG signals=${dgViolations} | gate hard=${gate.hardBlock} soft=[${gate.softFlags.join(", ")}]`
      );
      const tribunal = oracleTribunalVerdict(decision, gate);
      console.log(`[veridict] ${tribunal.record}`);

      if (gate.hardBlock) {
        recordDelegationGapHardBlock();
        const reason = `[VERIDICT mechanical gate — HARD] ${gate.findings.join("; ")}`;
        decision = {
          ...decision,
          action: "HOLD",
          amount: 0,
          reasoning: `${decision.reasoning} ${reason}`,
        };
      } else {
        if (decision.action !== "HOLD") {
          decision = {
            ...decision,
            reasoning: `${decision.reasoning} | [VERIDICT tribunal] ${tribunal.record}`,
          };
        }
        if (!tribunal.execute && decision.action !== "HOLD") {
          decision = {
            ...decision,
            action: "HOLD",
            amount: 0,
            reasoning: `${decision.reasoning} [BLOCKED by tribunal stub]`,
          };
        }
      }
      */

      // 5. Human-readable explanation
      const explanation = formatExplanation(decision, market);
      console.log(explanation);

      let intentHash = HOLD_INTENT_HASH;

      // 6. Actionable trade: submit signed TradeIntent to RiskRouter
      if (decision.action !== "HOLD" && decision.amount > 0) {

        // 6a. Build + sign the TradeIntent (EIP-712)
        const intent = await riskRouter.buildIntent(
          agentId,
          agentWallet.address,
          decision.pair,
          decision.action as "BUY" | "SELL",
          decision.amount
        );

        if (PREFLIGHT_SIMULATE_INTENT) {
          const pre = await riskRouter.simulateIntent(intent);
          if (!pre.approved) {
            console.warn(`[agent] TradeIntent preflight REJECTED (no gas spent): ${pre.reason}`);
            decision = {
              ...decision,
              action: "HOLD",
              amount: 0,
              reasoning: `${decision.reasoning} [RiskRouter preflight: ${pre.reason}]`,
            };
          }
        }

        if (decision.action !== "HOLD" && decision.amount > 0) {
          const signed = await riskRouter.signIntent(intent, agentWallet);
          intentHash = signed.intentHash;

          console.log(
            `[agent] TradeIntent signed. nonce=${intent.nonce}, deadline=${new Date(Number(intent.deadline) * 1000).toISOString()}`
          );

          // 6b. Submit to RiskRouter — on-chain validation (gas paid by routerSubmitter)
          const validation_result = await riskRouter.submitIntent(signed);

          if (!validation_result.approved) {
            console.warn(`[agent] TradeIntent REJECTED by RiskRouter: ${validation_result.reason}`);
            decision.action = "HOLD";
            decision.amount = 0;
            decision.reasoning += ` [BLOCKED by RiskRouter: ${validation_result.reason}]`;
          } else {
            const volumeBase = (decision.amount / market.price).toFixed(8);
            const result = await kraken.placeOrder({
              pair: decision.pair,
              type: decision.action === "BUY" ? "buy" : "sell",
              ordertype: "market",
              volume: volumeBase,
            });
            console.log(`[agent] Order placed: ${result.txid.join(", ")}`);
            console.log(`[agent] ${result.descr.order}`);
          }
        }
      }

      // 7. Generate EIP-712 signed checkpoint
      const checkpoint = await generateCheckpoint(
        agentId,
        decision,
        market,
        intentHash,
        agentWallet,
        registryAddress,
        SEPOLIA_CHAIN_ID
      );

      console.log(formatCheckpointLog(checkpoint));

      // 8. ValidationRegistry — operator posts EIP-712 attestation (+ gate/tribunal notes; stubs in study mode)
      const cp = checkpoint as typeof checkpoint & { checkpointHash?: string };
      const postThisCheckpoint =
        POST_VALIDATION_ATTESTATION &&
        Boolean(cp.checkpointHash) &&
        (!POST_VALIDATION_SKIP_HOLD || decision.action !== "HOLD");

      if (postThisCheckpoint) {
        const valScore = agentValidationScoreForPost(decision);
        const attestationNotes = buildValidationAttestationNotes(
          decision,
          market,
          gate,
          tribunal.record,
          trustLevel,
          dgViolations,
          intentHash
        );
        try {
          await validation.postCheckpointAttestation(agentId, cp.checkpointHash!, valScore, attestationNotes);
          console.log(`[agent] ValidationRegistry attestation posted (${valScore}/100): ${cp.checkpointHash!.slice(0, 18)}...`);
        } catch (e) {
          console.warn(
            `[agent] ValidationRegistry post failed (non-fatal). Ensure operator ${operatorSigner.address} is the registered agent owner / whitelisted:`,
            e
          );
        }
      }

      // 9. Persist to checkpoints.jsonl
      fs.appendFileSync(CHECKPOINTS_FILE, JSON.stringify(checkpoint) + "\n");

    } catch (err) {
      console.error(`[agent] Error in tick:`, err);
    } finally {
      tickBusy = false;
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — swap strategy here
// ─────────────────────────────────────────────────────────────────────────────

// ── SWAP STRATEGY HERE (must implement TradingStrategy) ─────────────────────
const _momTh = parseFloat(process.env.MOMENTUM_THRESHOLD_PCT || "0.5");
const _momThSafe = Number.isFinite(_momTh) ? _momTh : 0.5;
const _maxSpread = parseFloat(process.env.MOMENTUM_MAX_SPREAD_PCT || "0.1");
const _maxSpreadSafe = Number.isFinite(_maxSpread) ? _maxSpread : 0.1;
const strategy: TradingStrategy = new MomentumStrategy(5, 100, _momThSafe, _maxSpreadSafe);
console.log(
  `[agent] Strategy: MomentumStrategy (threshold ±${_momThSafe}%, max spread for BUY ${_maxSpreadSafe}%)`
);
// ────────────────────────────────────────────────────────────────────────────

runAgent(strategy).catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});

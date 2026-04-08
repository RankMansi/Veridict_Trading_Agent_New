/**
 * Main agent loop — VERIDICT-aligned template: mechanical gate + tribunal stub + ERC-8004 + Kraken
 *
 * Each tick:
 *   1. Fetch market data (Kraken CLI, or public REST fallback if CLI missing / KRAKEN_USE_REST)
 *   2. Strategy.analyze(market) → TradeDecision
 *   3. Delegation Gap Sentinel (policy allowlist + trust-adjusted caps) — hard blocks become HOLD
 *   4. ORACLE Tribunal stub — audit string appended to reasoning (full debate in Python VERIDICT)
 *   5. Format human-readable explanation
 *   6. If BUY/SELL:
 *      a. Build + sign TradeIntent (EIP-712, agentWallet)
 *      b. Submit TradeIntent to RiskRouter — get approval/rejection on-chain
 *      c. If approved: execute via Kraken CLI
 *   5. Generate EIP-712 signed checkpoint (includes intentHash)
 *   6. Post checkpoint hash to ValidationRegistry
 *   7. Append checkpoint to checkpoints.jsonl
 *
 * Swap strategy: change the strategy instantiation at the bottom of this file.
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
import { loadPolicyFromEnv, runDelegationGapSentinel } from "../veridict/policyGate";
import { recordDelegationGapHardBlock, getTrustLevel, getDelegationGapViolations } from "../veridict/trustState";
import { oracleTribunalVerdict } from "../veridict/tribunalStub";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SEPOLIA_CHAIN_ID = 11155111;
const TRADING_PAIR    = process.env.TRADING_PAIR || "BTCUSD";
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || "30000");
const CHECKPOINTS_FILE = path.join(process.cwd(), "checkpoints.jsonl");
const HOLD_INTENT_HASH = ethers.ZeroHash; // used for HOLD decisions (no intent submitted)

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
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
  const kraken     = new KrakenClient();
  const vault      = new VaultClient(vaultAddress, provider);
  const riskRouter = new RiskRouterClient(routerAddress, agentWallet, SEPOLIA_CHAIN_ID);
  const validation = new ValidationRegistryClient(validationAddress, agentWallet);

  const policy = loadPolicyFromEnv();
  console.log(`\n[veridict] Every trade is a verdict — checkpoints are verifiable (EIP-712 + ValidationRegistry).`);
  console.log(
    `[veridict] Mechanical gate: allowlist [${[...policy.allowedPairs].join(", ")}], base cap $${policy.maxTradeUsd} (trust-adjusted).`
  );
  console.log(`[veridict] Full PolicySpec hash, IPFS artifacts, and ORACLE Tribunal judges → Python VERIDICT repo.\n`);

  console.log(`[agent] Starting agent loop`);
  console.log(`[agent] agentId:  ${agentId}`);
  console.log(`[agent] Pair:     ${TRADING_PAIR}`);
  console.log(`[agent] Interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`[agent] Checkpoints: ${CHECKPOINTS_FILE}\n`);

  // ─────────────────────────────────────────────────────────────────────────
  // Main tick
  // ─────────────────────────────────────────────────────────────────────────

  const tick = async () => {
    try {
      // 1. Fetch market data via Kraken CLI
      const market = await kraken.getTicker(TRADING_PAIR);
      console.log(`[agent] ${TRADING_PAIR} @ $${market.price.toLocaleString()}`);

      // 2. Strategy decision
      let decision = await strategy.analyze(market);

      // 3–4. VERIDICT — Delegation Gap Sentinel + ORACLE Tribunal (stub)
      const gate = runDelegationGapSentinel(decision, policy);
      console.log(
        `[veridict] Trust=${getTrustLevel()} DG signals=${getDelegationGapViolations()} | gate hard=${gate.hardBlock} soft=[${gate.softFlags.join(", ")}]`
      );
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
        const tribunal = oracleTribunalVerdict(decision, gate);
        console.log(`[veridict] ${tribunal.record}`);
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
        const signed = await riskRouter.signIntent(intent, agentWallet);
        intentHash = signed.intentHash;

        console.log(`[agent] TradeIntent signed. nonce=${intent.nonce}, deadline=${new Date(Number(intent.deadline) * 1000).toISOString()}`);

        // 6b. Submit to RiskRouter — on-chain validation
        const validation_result = await riskRouter.submitIntent(signed);

        if (!validation_result.approved) {
          console.warn(`[agent] TradeIntent REJECTED by RiskRouter: ${validation_result.reason}`);
          // Don't execute — fall through to checkpoint (HOLD behaviour)
          decision.action = "HOLD";
          decision.amount = 0;
          decision.reasoning += ` [BLOCKED by RiskRouter: ${validation_result.reason}]`;
        } else {
          // 6c. Execute via Kraken CLI (or simulated paper if REST fallback)
          const volumeBase = (decision.amount / market.price).toFixed(8);
          const result = await kraken.placeOrder({
            pair:      decision.pair,
            type:      decision.action === "BUY" ? "buy" : "sell",
            ordertype: "market",
            volume:    volumeBase,
          });
          console.log(`[agent] Order placed: ${result.txid.join(", ")}`);
          console.log(`[agent] ${result.descr.order}`);
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

      // 8. Post checkpoint hash to ValidationRegistry
      const cp = checkpoint as typeof checkpoint & { checkpointHash?: string };
      if (cp.checkpointHash) {
        try {
          await validation.postCheckpointAttestation(
            agentId,
            cp.checkpointHash,
            Math.round(decision.confidence * 100), // self-assessed score
            `${decision.action} ${decision.pair} @ $${market.price}`
          );
          console.log(`[agent] Checkpoint posted to ValidationRegistry: ${cp.checkpointHash.slice(0, 20)}...`);
        } catch (e) {
          console.warn(`[agent] ValidationRegistry post failed (non-fatal):`, e);
        }
      }

      // 9. Persist to checkpoints.jsonl
      fs.appendFileSync(CHECKPOINTS_FILE, JSON.stringify(checkpoint) + "\n");

    } catch (err) {
      console.error(`[agent] Error in tick:`, err);
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — swap strategy here
// ─────────────────────────────────────────────────────────────────────────────

// ── SWAP YOUR STRATEGY HERE ─────────────────────────────────────────────────
// import { LLMStrategy } from "./strategy.js";
// const strategy = new LLMStrategy();
const _momTh = parseFloat(process.env.MOMENTUM_THRESHOLD_PCT || "0.04");
const _win = parseInt(process.env.MOMENTUM_WINDOW || "3", 10);
const _usd = parseFloat(process.env.TRADE_AMOUNT_USD || "150");
const windowSize = Number.isFinite(_win) && _win >= 2 ? _win : 3;
const tradeUsd = Number.isFinite(_usd) && _usd > 0 && _usd <= 500 ? _usd : 150;
const strategy = new MomentumStrategy(
  windowSize,
  tradeUsd,
  Number.isFinite(_momTh) ? _momTh : 0.04
);
// ────────────────────────────────────────────────────────────────────────────

runAgent(strategy).catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});

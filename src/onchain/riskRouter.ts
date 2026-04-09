/**
 * RiskRouter — TypeScript integration layer
 *
 * Implements the full ERC-8004 TradeIntent flow:
 *   1. Build a TradeIntent struct for a proposed trade
 *   2. Sign it with EIP-712 using the agent's hot wallet (agentWallet)
 *   3. Submit the signed intent to the RiskRouter contract
 *   4. Parse the approval/rejection result
 *
 * The same SignedTradeIntent can be submitted to the hackathon-provided router
 * contract by just pointing to its address — the EIP-712 domain will differ
 * (different verifyingContract address), so re-sign against the hackathon router.
 */

import { ethers } from "ethers";
import { TradeIntent, SignedTradeIntent } from "../types/index";

function readGasLimitCap(envKey: string, defaultDecimal: string): bigint {
  const raw = process.env[envKey]?.trim();
  if (!raw) return BigInt(defaultDecimal);
  try {
    const v = raw.startsWith("0x") || raw.startsWith("0X") ? BigInt(raw) : BigInt(raw);
    return v > 0n ? v : BigInt(defaultDecimal);
  } catch {
    return BigInt(defaultDecimal);
  }
}

async function gasOverrides(
  provider: ethers.Provider,
  txReq: { to: string; data: string; from: string },
  cap: bigint,
  floor: bigint
): Promise<ethers.Overrides> {
  try {
    const est = await provider.estimateGas(txReq);
    const buffered = (est * 125n) / 100n;
    let g = buffered < floor ? floor : buffered;
    if (g > cap) g = cap;
    return { gasLimit: g };
  } catch {
    return { gasLimit: cap };
  }
}

const RISK_ROUTER_ABI = [
  "function submitTradeIntent((uint256 agentId, address agentWallet, string pair, string action, uint256 amountUsdScaled, uint256 maxSlippageBps, uint256 nonce, uint256 deadline) intent, bytes signature) external returns (bool approved, string reason)",
  "function simulateIntent((uint256 agentId, address agentWallet, string pair, string action, uint256 amountUsdScaled, uint256 maxSlippageBps, uint256 nonce, uint256 deadline) intent) external view returns (bool approved, string reason)",
  "function setRiskParams(uint256 agentId, uint256 maxPositionUsdScaled, uint256 maxDrawdownBps, uint256 maxTradesPerHour) external",
  "function getRiskParams(uint256 agentId) external view returns (tuple(uint256 maxPositionUsdScaled, uint256 maxDrawdownBps, uint256 maxTradesPerHour, bool active))",
  "function getIntentNonce(uint256 agentId) external view returns (uint256)",
  "function getTradeRecord(uint256 agentId) external view returns (uint256 count, uint256 windowStart)",
  "function domainSeparator() external view returns (bytes32)",
  "event TradeApproved(uint256 indexed agentId, bytes32 indexed intentHash, uint256 amountUsdScaled)",
  "event TradeRejected(uint256 indexed agentId, bytes32 indexed intentHash, string reason)",
];

// EIP-712 type definition matching the Solidity TRADE_INTENT_TYPEHASH
const TRADE_INTENT_TYPES = {
  TradeIntent: [
    { name: "agentId",           type: "uint256" },
    { name: "agentWallet",       type: "address" },
    { name: "pair",              type: "string"  },
    { name: "action",            type: "string"  },
    { name: "amountUsdScaled",   type: "uint256" },
    { name: "maxSlippageBps",    type: "uint256" },
    { name: "nonce",             type: "uint256" },
    { name: "deadline",          type: "uint256" },
  ],
} as const;

export interface RiskValidationResult {
  approved: boolean;
  reason: string;
  intentHash?: string;
}

export class RiskRouterClient {
  private contract: ethers.Contract;
  private routerAddress: string;
  private chainId: number;

  constructor(
    routerAddress: string,
    signerOrProvider: ethers.Signer | ethers.Provider,
    chainId: number
  ) {
    this.contract = new ethers.Contract(routerAddress, RISK_ROUTER_ABI, signerOrProvider);
    this.routerAddress = routerAddress;
    this.chainId = chainId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Intent building
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build a TradeIntent for a proposed trade, fetching the current nonce.
   */
  async buildIntent(
    agentId: bigint,
    agentWallet: string,
    pair: string,
    action: "BUY" | "SELL",
    amountUsd: number,
    options: { maxSlippageBps?: number; deadlineSeconds?: number } = {}
  ): Promise<TradeIntent> {
    const nonce = await this.contract.getIntentNonce(agentId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (options.deadlineSeconds ?? 300)); // 5 min default

    return {
      agentId,
      agentWallet,
      pair,
      action,
      amountUsdScaled: BigInt(Math.round(amountUsd * 100)),
      maxSlippageBps: BigInt(options.maxSlippageBps ?? 50), // 0.5% default
      nonce: BigInt(nonce),
      deadline,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EIP-712 signing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sign a TradeIntent with EIP-712 using the agent's hot wallet.
   * The domain uses the RiskRouter contract address as verifyingContract.
   */
  async signIntent(intent: TradeIntent, agentWalletSigner: ethers.Wallet): Promise<SignedTradeIntent> {
    const domain: ethers.TypedDataDomain = {
      name: "RiskRouter",
      version: "1",
      chainId: this.chainId,
      verifyingContract: this.routerAddress,
    };

    const value = {
      agentId: intent.agentId,
      agentWallet: intent.agentWallet,
      pair: intent.pair,
      action: intent.action,
      amountUsdScaled: intent.amountUsdScaled,
      maxSlippageBps: intent.maxSlippageBps,
      nonce: intent.nonce,
      deadline: intent.deadline,
    };

    const signature = await agentWalletSigner.signTypedData(domain, TRADE_INTENT_TYPES as unknown as Record<string, ethers.TypedDataField[]>, value);

    // Compute intentHash for logging/correlation
    const intentHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "string", "string", "uint256", "uint256"],
      [intent.agentId, intent.agentWallet, intent.pair, intent.action, intent.amountUsdScaled, intent.nonce]
    ));

    return { intent, signature, intentHash };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Submission
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submit a signed TradeIntent to the RiskRouter for validation.
   * This is the state-changing call — updates nonce + trade record if approved.
   */
  async submitIntent(signed: SignedTradeIntent): Promise<RiskValidationResult> {
    const intentStruct = [
      signed.intent.agentId,
      signed.intent.agentWallet,
      signed.intent.pair,
      signed.intent.action,
      signed.intent.amountUsdScaled,
      signed.intent.maxSlippageBps,
      signed.intent.nonce,
      signed.intent.deadline,
    ];

    const runner = this.contract.runner;
    let overrides: ethers.Overrides = {};
    if (runner && "getAddress" in runner) {
      const provider = runner.provider;
      if (provider) {
        const signer = runner as ethers.Signer;
        const from = await signer.getAddress();
        const pop = await this.contract.submitTradeIntent.populateTransaction(intentStruct, signed.signature);
        overrides = await gasOverrides(
          provider,
          { to: pop.to as string, data: pop.data ?? "0x", from },
          readGasLimitCap("HACKATHON_GAS_LIMIT_ROUTER", "450000"),
          180000n
        );
      }
    }

    // State-changing calls return a TransactionResponse — not (bool, string). Decode from receipt events.
    const tx = await this.contract.submitTradeIntent(intentStruct, signed.signature, overrides);
    const receipt = await tx.wait();
    if (!receipt) {
      return { approved: false, reason: "No receipt from submitTradeIntent", intentHash: signed.intentHash };
    }
    if (receipt.status !== 1) {
      return { approved: false, reason: "submitTradeIntent transaction reverted", intentHash: signed.intentHash };
    }

    const iface = new ethers.Interface(RISK_ROUTER_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        if (parsed.name === "TradeRejected") {
          const reason = String((parsed.args as { reason?: string }).reason ?? "");
          return { approved: false, reason: reason || "(empty rejection reason)", intentHash: signed.intentHash };
        }
        if (parsed.name === "TradeApproved") {
          return { approved: true, reason: "", intentHash: signed.intentHash };
        }
      } catch {
        /* log from another contract */
      }
    }

    return {
      approved: false,
      reason: "No TradeApproved/TradeRejected in receipt — check router address / ABI",
      intentHash: signed.intentHash,
    };
  }

  /**
   * Simulate submission without changing state (pre-flight check, no gas).
   */
  async simulateIntent(intent: TradeIntent): Promise<RiskValidationResult> {
    const intentStruct = [
      intent.agentId,
      intent.agentWallet,
      intent.pair,
      intent.action,
      intent.amountUsdScaled,
      intent.maxSlippageBps,
      intent.nonce,
      intent.deadline,
    ];
    const result = await this.contract.simulateIntent(intentStruct);
    return { approved: result[0], reason: result[1] };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Config + views
  // ─────────────────────────────────────────────────────────────────────────

  async setRiskParams(
    agentId: bigint,
    maxPositionUsd: number,
    maxDrawdownBps: number,
    maxTradesPerHour: number
  ): Promise<ethers.TransactionReceipt> {
    const maxPos = BigInt(Math.round(maxPositionUsd * 100));
    const dd = BigInt(maxDrawdownBps);
    const tph = BigInt(maxTradesPerHour);

    const runner = this.contract.runner;
    let overrides: ethers.Overrides = {};
    if (runner && "getAddress" in runner) {
      const provider = runner.provider;
      if (provider) {
        const signer = runner as ethers.Signer;
        const from = await signer.getAddress();
        const pop = await this.contract.setRiskParams.populateTransaction(agentId, maxPos, dd, tph);
        overrides = await gasOverrides(
          provider,
          { to: pop.to as string, data: pop.data ?? "0x", from },
          readGasLimitCap("HACKATHON_GAS_LIMIT_ROUTER", "450000"),
          120000n
        );
      }
    }

    const tx = await this.contract.setRiskParams(agentId, maxPos, dd, tph, overrides);
    return tx.wait();
  }

  async getRiskParams(agentId: bigint) {
    const p = await this.contract.getRiskParams(agentId);
    return {
      maxPositionUsd: Number(p.maxPositionUsdScaled) / 100,
      maxDrawdownBps: Number(p.maxDrawdownBps),
      maxTradesPerHour: Number(p.maxTradesPerHour),
      active: p.active,
    };
  }

  async getCurrentNonce(agentId: bigint): Promise<bigint> {
    return this.contract.getIntentNonce(agentId);
  }
}

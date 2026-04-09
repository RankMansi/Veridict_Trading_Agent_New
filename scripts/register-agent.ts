/**
 * Register your AI agent on-chain via ERC-8004 (ERC-721 mint).
 *
 * Usage:
 *   npx ts-node scripts/register-agent.ts
 *
 * Prerequisites:
 *   - Path A: shared AGENT_REGISTRY_ADDRESS in .env (do NOT deploy for hackathon judging)
 *   - PRIVATE_KEY + SEPOLIA_RPC_URL in .env
 *
 * What it does:
 *   1. Mints an ERC-721 token to your wallet — this is your agent's on-chain identity
 *   2. Registers agentWallet (hot wallet for signing)
 *   3. Prints the agentId (token ID) — add it to .env as AGENT_ID
 *   4. Optionally sets risk params on the RiskRouter
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { getAgentId } from "../src/agent/identity";

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

async function main() {
  const rpcUrl          = process.env.SEPOLIA_RPC_URL;
  const privateKey      = process.env.PRIVATE_KEY;
  const registryAddress = process.env.AGENT_REGISTRY_ADDRESS;
  const routerAddress   = process.env.RISK_ROUTER_ADDRESS;

  if (!rpcUrl)          throw new Error("Missing SEPOLIA_RPC_URL");
  if (!privateKey)      throw new Error("Missing PRIVATE_KEY");
  if (!registryAddress) {
    throw new Error(
      "Missing AGENT_REGISTRY_ADDRESS — set shared AgentRegistry from SHARED_CONTRACTS.md (do not deploy for judging)"
    );
  }

  const provider       = new ethers.JsonRpcProvider(rpcUrl);
  const operatorSigner = new ethers.Wallet(privateKey, provider);

  // Agent hot wallet: use AGENT_WALLET_PRIVATE_KEY if set, else same as operator
  const agentWalletKey = process.env.AGENT_WALLET_PRIVATE_KEY || privateKey;
  const agentWallet    = new ethers.Wallet(agentWalletKey);

  console.log(`\nOperator wallet: ${operatorSigner.address}`);
  console.log(`Agent wallet:    ${agentWallet.address}`);
  console.log(`AgentRegistry:   ${registryAddress}\n`);

  const agentName = (process.env.AGENT_NAME || "VERIDICT").trim();
  const agentDesc = (
    process.env.AGENT_DESCRIPTION ||
    "Policy-bound autonomous trading agent: ERC-8004 identity, Kraken execution, EIP-712 checkpoints and verifiable decisions."
  ).trim();
  const caps = (process.env.AGENT_CAPABILITIES || "trading,analysis,explainability,eip712-signing,veridict")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Register agent (mints ERC-721)
  const agentId = await getAgentId(operatorSigner, registryAddress, {
    name: agentName,
    description: agentDesc,
    capabilities: caps.length ? caps : ["trading", "eip712-signing"],
    agentWallet: agentWallet.address,
    agentURI: `data:application/json,${encodeURIComponent(JSON.stringify({
      name: agentName,
      version: "1.0.0",
      agentWallet: agentWallet.address,
      capabilities: caps,
    }))}`,
  });

  console.log(`\nAgent registered!`);
  console.log(`agentId (ERC-721 token ID): ${agentId}`);
  console.log(`\nAdd to .env:`);
  console.log(`  AGENT_ID=${agentId}`);
  if (agentWalletKey !== privateKey) {
    console.log(`  AGENT_WALLET_PRIVATE_KEY=${agentWalletKey}`);
  }

  // Optional: local deploys may expose setRiskParams — shared hackathon router may not
  if (routerAddress && process.env.RISK_ROUTER_SET_PARAMS === "true") {
    const RISK_ROUTER_ABI = [
      "function setRiskParams(uint256 agentId, uint256 maxPositionUsdScaled, uint256 maxDrawdownBps, uint256 maxTradesPerHour) external",
    ];
    try {
      const router = new ethers.Contract(routerAddress, RISK_ROUTER_ABI, operatorSigner);
      console.log(`\nSetting risk params on RiskRouter...`);
      const maxPos = BigInt(50000);
      const dd = BigInt(500);
      const tph = BigInt(10);
      const from = await operatorSigner.getAddress();
      const pop = await router.setRiskParams.populateTransaction(agentId, maxPos, dd, tph);
      const overrides = await gasOverrides(
        provider,
        { to: pop.to as string, data: pop.data ?? "0x", from },
        readGasLimitCap("HACKATHON_GAS_LIMIT_ROUTER", "450000"),
        120000n
      );
      const tx = await router.setRiskParams(agentId, maxPos, dd, tph, overrides);
      await tx.wait();
      console.log(`Risk params set: maxPosition=$500, maxDrawdown=5%, maxTrades/hr=10`);
    } catch (e) {
      console.log(
        "[register] RiskRouter.setRiskParams skipped or failed (normal for shared contracts):",
        (e as Error).message?.slice(0, 120)
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

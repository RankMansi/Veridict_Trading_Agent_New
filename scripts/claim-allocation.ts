/**
 * Path A — Optional: claim HackathonVault allocation (~0.05 ETH per agentId, once).
 * Judging does not require the vault; register + RiskRouter + ValidationRegistry suffice.
 *
 * Prerequisites: AGENT_ID in .env after `npm run register`
 * Usage: npm run claim
 */
import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

const VAULT_ABI = [
  "function claimAllocation(uint256 agentId) external",
  "function getBalance(uint256 agentId) external view returns (uint256)",
  "function hasClaimed(uint256 agentId) external view returns (bool)",
  "function allocationPerTeam() external view returns (uint256)",
];

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL;
  const pk = process.env.PRIVATE_KEY;
  const vaultAddr = process.env.HACKATHON_VAULT_ADDRESS;
  const agentIdRaw = process.env.AGENT_ID;

  if (!rpc) throw new Error("Missing SEPOLIA_RPC_URL");
  if (!pk) throw new Error("Missing PRIVATE_KEY");
  if (!vaultAddr) throw new Error("Missing HACKATHON_VAULT_ADDRESS");
  if (!agentIdRaw) throw new Error("Missing AGENT_ID — run npm run register first");

  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(pk, provider);
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, signer);

  const agentId = BigInt(agentIdRaw);
  console.log(`Operator: ${signer.address}`);
  console.log(`Vault:    ${vaultAddr}`);
  console.log(`agentId:  ${agentId}`);

  const claimed = await vault.hasClaimed(agentId);
  if (claimed) {
    const bal = await vault.getBalance(agentId);
    console.log(`Already claimed. getBalance(agentId): ${ethers.formatEther(bal)} ETH (vault accounting)`);
    return;
  }

  const alloc = await vault.allocationPerTeam();
  console.log(`allocationPerTeam: ${ethers.formatEther(alloc)} ETH`);

  console.log("Sending claimAllocation...");
  const tx = await vault.claimAllocation(agentId);
  console.log(`Tx: ${tx.hash}`);
  await tx.wait();
  console.log("✅ claimAllocation confirmed");

  const balAfter = await vault.getBalance(agentId);
  console.log(`getBalance(agentId): ${ethers.formatEther(balAfter)} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

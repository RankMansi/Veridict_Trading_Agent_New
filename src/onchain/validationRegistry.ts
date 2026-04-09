/**
 * ValidationRegistry — same shared Sepolia registry (`VALIDATION_REGISTRY_ADDRESS` in .env).
 *
 * Registered **agent operators** sign with `PRIVATE_KEY` (operator). We call **`postAttestation`**
 * with `proofType = EIP712 (1)` and empty `proof` — not `postEIP712Attestation` — because the
 * deployed contract’s `postEIP712Attestation` uses `this.postAttestation` and reverts for
 * whitelisted EOAs. Set `POST_VALIDATION_ATTESTATION=false` to skip posts (gas / debugging).
 */

import { ethers } from "ethers";

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

const VALIDATION_ABI = [
  "function postAttestation(uint256 agentId, bytes32 checkpointHash, uint8 score, uint8 proofType, bytes proof, string notes) external",
  "function postEIP712Attestation(uint256 agentId, bytes32 checkpointHash, uint8 score, string notes) external",
  "function getAttestations(uint256 agentId) external view returns (tuple(uint256 agentId, address validator, bytes32 checkpointHash, uint8 score, uint8 proofType, bytes proof, string notes, uint256 timestamp)[])",
  "function getAverageValidationScore(uint256 agentId) external view returns (uint256)",
  "function getAttestation(bytes32 checkpointHash) external view returns (tuple(uint256 agentId, address validator, bytes32 checkpointHash, uint8 score, uint8 proofType, bytes proof, string notes, uint256 timestamp))",
  "function attestationCount(uint256 agentId) external view returns (uint256)",
  "event AttestationPosted(uint256 indexed agentId, address indexed validator, bytes32 indexed checkpointHash, uint8 score, uint8 proofType)",
];

export enum ProofType {
  NONE = 0,
  EIP712 = 1,
  TEE = 2,
  ZKML = 3,
}

export interface Attestation {
  agentId: bigint;
  validator: string;
  checkpointHash: string;
  score: number;
  proofType: ProofType;
  proof: string;
  notes: string;
  timestamp: number;
}

export class ValidationRegistryClient {
  private contract: ethers.Contract;

  constructor(registryAddress: string, signerOrProvider: ethers.Signer | ethers.Provider) {
    this.contract = new ethers.Contract(registryAddress, VALIDATION_ABI, signerOrProvider);
  }

  /**
   * Post an EIP-712 checkpoint attestation.
   * Call this after generating each signed checkpoint to record it on-chain.
   *
   * @param agentId        ERC-721 agent token ID
   * @param checkpointHash The EIP-712 digest of the signed checkpoint
   * @param score          Self-assessed quality score 0–100 (validators override this)
   * @param notes          Optional description of the checkpoint
   */
  async postCheckpointAttestation(
    agentId: bigint,
    checkpointHash: string,
    score: number,
    notes: string
  ): Promise<ethers.TransactionReceipt> {
    /**
     * Call `postAttestation` directly with ProofType.EIP712 — NOT `postEIP712Attestation`.
     * Deployed ValidationRegistry uses `this.postAttestation(...)` inside postEIP712Attestation,
     * which re-enters as an external call so msg.sender becomes the contract and onlyValidator fails
     * for whitelisted operators. Direct postAttestation keeps msg.sender as the operator.
     */
    const proofBytes = "0x";
    const runner = this.contract.runner;
    let overrides: ethers.Overrides = {};
    if (runner && "getAddress" in runner) {
      const provider = runner.provider;
      if (provider) {
        const signer = runner as ethers.Signer;
        const from = await signer.getAddress();
        const pop = await this.contract.postAttestation.populateTransaction(
          agentId,
          checkpointHash,
          score,
          ProofType.EIP712,
          proofBytes,
          notes
        );
        const cap = readGasLimitCap("HACKATHON_GAS_LIMIT_VALIDATION", "2500000");
        overrides = await gasOverrides(
          provider,
          { to: pop.to as string, data: pop.data ?? "0x", from },
          cap,
          120000n
        );
      }
    }
    const tx = await this.contract.postAttestation(
      agentId,
      checkpointHash,
      score,
      ProofType.EIP712,
      proofBytes,
      notes,
      overrides
    );
    return tx.wait();
  }

  /**
   * Post a full attestation with proof bytes (for TEE or zkML proofs).
   */
  async postAttestation(
    agentId: bigint,
    checkpointHash: string,
    score: number,
    proofType: ProofType,
    proof: Uint8Array | string,
    notes: string
  ): Promise<ethers.TransactionReceipt> {
    const proofBytes = typeof proof === "string" ? proof : ethers.hexlify(proof);

    const runner = this.contract.runner;
    let overrides: ethers.Overrides = {};
    if (runner && "getAddress" in runner) {
      const provider = runner.provider;
      if (provider) {
        const signer = runner as ethers.Signer;
        const from = await signer.getAddress();
        const pop = await this.contract.postAttestation.populateTransaction(
          agentId,
          checkpointHash,
          score,
          proofType,
          proofBytes,
          notes
        );
        const cap = readGasLimitCap("HACKATHON_GAS_LIMIT_VALIDATION", "2500000");
        overrides = await gasOverrides(
          provider,
          { to: pop.to as string, data: pop.data ?? "0x", from },
          cap,
          120000n
        );
      }
    }

    const tx = await this.contract.postAttestation(
      agentId,
      checkpointHash,
      score,
      proofType,
      proofBytes,
      notes,
      overrides
    );
    return tx.wait();
  }

  /**
   * Get all attestations for an agent.
   */
  async getAttestations(agentId: bigint): Promise<Attestation[]> {
    const atts = await this.contract.getAttestations(agentId);
    return atts.map((a: { agentId: bigint; validator: string; checkpointHash: string; score: bigint; proofType: bigint; proof: string; notes: string; timestamp: bigint }) => ({
      agentId: a.agentId,
      validator: a.validator,
      checkpointHash: a.checkpointHash,
      score: Number(a.score),
      proofType: Number(a.proofType) as ProofType,
      proof: a.proof,
      notes: a.notes,
      timestamp: Number(a.timestamp),
    }));
  }

  /**
   * Get the average validation score across all attestations for an agent.
   */
  async getAverageScore(agentId: bigint): Promise<number> {
    return Number(await this.contract.getAverageValidationScore(agentId));
  }
}

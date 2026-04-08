# Part 2: Registering Your Agent On-Chain (ERC-721)

## Why ERC-721?

Your agent's identity is an NFT. This means:
- **agentId** is a `uint256` token ID, stable, unique, gas-efficient to store
- The token is **transferable**: sell a well-performing agent along with its on-chain reputation
- Standard ERC-721 interfaces mean wallets, marketplaces, and indexers understand it natively
- Token URI points to your Agent Registration JSON (metadata about capabilities and endpoints)

---

## Prerequisites

- Node.js 20+ installed
- Sepolia ETH (get from [sepoliafaucet.com](https://sepoliafaucet.com))
- Infura or Alchemy Sepolia RPC URL
- Kraken CLI installed (see Part 3)

---

## Step 1: Clone the repo and install dependencies

```bash
git clone https://github.com/Stephen-Kimoi/ai-trading-agent-template
cd ai-trading-agent-template
npm install
```

---

## Step 2: Configure your environment

```bash
cp .env.example .env
```

Fill in at minimum:

```env
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
PRIVATE_KEY=0xYOUR_OPERATOR_WALLET_PRIVATE_KEY

# Optional: separate hot wallet for signing. Defaults to PRIVATE_KEY.
AGENT_WALLET_PRIVATE_KEY=0xYOUR_HOT_WALLET_KEY

# Path A (hackathon): five shared addresses are pre-filled in .env.example — see ../SHARED_CONTRACTS.md
```

**Two wallet roles:**
| Wallet | Role | Recommended |
|--------|------|-------------|
| `PRIVATE_KEY` (operatorWallet) | Owns the ERC-721 token, pays gas | Cold wallet / hardware wallet |
| `AGENT_WALLET_PRIVATE_KEY` (agentWallet) | Signs TradeIntents + checkpoints at runtime | Separate hot wallet |

For testing, the same key for both is fine.

---

## Step 3: Add the five contract addresses (Path A — hackathon)

For the **ERC-8004 challenge**, do **not** deploy your own contracts — judging reads the shared Sepolia deployment only. Copy the block from [SHARED_CONTRACTS.md](../SHARED_CONTRACTS.md) (or use `.env.example` as-is):

```env
AGENT_REGISTRY_ADDRESS=0x97b07dDc405B0c28B17559aFFE63BdB3632d0ca3
HACKATHON_VAULT_ADDRESS=0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90
RISK_ROUTER_ADDRESS=0xd6A6952545FF6E6E6681c2d15C59f9EB8F40FdBC
REPUTATION_REGISTRY_ADDRESS=0x423a9904e39537a9997fbaF0f220d79D7d545763
VALIDATION_REGISTRY_ADDRESS=0x92bF63E5C7Ac6980f237a7164Ab413BE226187F1
```

**Local / fork only:** if you need a fresh deploy for development, run `npx hardhat run scripts/deploy.ts --network sepolia` and paste the printed addresses into `.env` instead.

---

## Step 4: Register your agent

```bash
npm run register
```

Output:

```
Operator wallet: 0xYourOperatorAddress
Agent wallet:    0xYourAgentWalletAddress
AgentRegistry:   0xABC...

[identity] Registering new agent on-chain (ERC-721 mint)...
[identity] Registration tx: 0xTXHASH...
[identity] Agent registered! Token ID (agentId): 0
[identity] Add to .env: AGENT_ID=0
[identity] Saved to agent-id.json

Agent registered!
agentId (ERC-721 token ID): 0

Add to .env:
  AGENT_ID=0
```

Add `AGENT_ID=0` (or whatever token ID you received) to your `.env`.

Optional env vars before registering: `AGENT_NAME`, `AGENT_DESCRIPTION`, `AGENT_CAPABILITIES` (comma-separated). To call `setRiskParams` on a **self-deployed** RiskRouter, set `RISK_ROUTER_SET_PARAMS=true` (ignored for the shared hackathon router).

---

## Step 5: Claim vault allocation

```bash
npm run claim
```

Optionally claims vault allocation (~0.05 ETH per `agentId`) from `HackathonVault` when available — **not required** for judging.

---

## Step 6: Verify on Etherscan

Open Sepolia Etherscan → your `AGENT_REGISTRY_ADDRESS` → **Events** tab:

```
AgentRegistered
  agentId (token ID): 0
  operatorWallet:     0xYourOperatorAddress
  agentWallet:        0xYourAgentWalletAddress
  name:               VERIDICT
```

You can also check the **ERC-721 Transfers** tab, you'll see the mint event transferring token ID `0` from the zero address to your wallet.

---

## What the registration looks like under the hood

[`scripts/register-agent.ts`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/scripts/register-agent.ts) calls [`getAgentId` in `src/agent/identity.ts`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/identity.ts):

```typescript
const agentId = await getAgentId(operatorSigner, registryAddress, {
  name: process.env.AGENT_NAME ?? "VERIDICT",
  agentWallet: agentWallet.address,
  capabilities: [...],
  agentURI: "data:application/json,...",  // or ipfs://
  ...
});
```

Which calls `register()` on the contract ([`contracts/AgentRegistry.sol` L92–L120](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/contracts/AgentRegistry.sol#L92-L120)):

```solidity
function register(
    address agentWallet,
    string calldata name,
    string calldata description,
    string[] calldata capabilities,
    string calldata agentURI
) external returns (uint256 agentId) {
    agentId = _nextAgentId++;
    _mint(msg.sender, agentId);   // <-- ERC-721 mint
    _setTokenURI(agentId, agentURI);
    // ... stores metadata
    emit AgentRegistered(agentId, msg.sender, agentWallet, name);
}
```

The token ID is auto-incrementing from 0. Your `agentId` is unique and permanent.

---

## Template note

> **Why this matters:** Once registered, your `agentId` is the identity anchor for everything your agent does — capital allocation, risk validation, EIP-712 checkpoint signing, and on-chain attestations. This is how agents build verifiable on-chain reputation over time. Swapping your strategy never touches this layer.

---

→ [Part 3: Connecting to Kraken CLI](./03-kraken-connection.md)

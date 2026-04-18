# AI Trading Agent - Veridict

A complete, reusable AI trading agent with:
- **On-chain identity** via ERC-8004 Agent Registry (Sepolia)
- **Trade execution** via [Kraken CLI](https://github.com/kraken-oss/kraken-cli) (`paper` subcommands by default; public REST ticker fallback if the binary is missing)
- **Capital management** via Hackathon Vault + Risk Router contracts
- **Cryptographic explainability** via EIP-712 signed checkpoints

Any team can pick this up, swap in their own model or strategy, and run it — the identity, risk, and audit layers stay the same.

**Hackathon (Path A):** Use the [shared Sepolia contracts](SHARED_CONTRACTS.md) already deployed — do **not** run `scripts/deploy.ts` for judging. Full flow and ABIs: [SHARED_CONTRACTS.md](SHARED_CONTRACTS.md).

---

## Shared contracts (Sepolia, chain ID `11155111`)

| Contract | Address |
|---|---|
| AgentRegistry | `0x97b07dDc405B0c28B17559aFFE63BdB3632d0ca3` |
| HackathonVault | `0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90` |
| RiskRouter | `0xd6A6952545FF6E6E6681c2d15C59f9EB8F40FdBC` |
| ReputationRegistry | `0x423a9904e39537a9997fbaF0f220d79D7d545763` |
| ValidationRegistry | `0x92bF63E5C7Ac6980f237a7164Ab413BE226187F1` |

Etherscan links and Path B (custom stack) interfaces live in [SHARED_CONTRACTS.md](SHARED_CONTRACTS.md).

**ValidationRegistry (operator whitelist):** On shared Sepolia, the template **`postAttestation` (EIP-712 proof type, empty proof)** from your **operator** wallet — not `postEIP712Attestation`, which reverts on the deployed bytecode (`this.postAttestation` breaks `msg.sender`). **`notes`** summarize Delegation Gap, tribunal, and RiskRouter outcome. Set `POST_VALIDATION_ATTESTATION=false` to disable. **`AGENT_VALIDATION_SCORE`** defaults to **100** (or **`auto`**). Local `contracts/ValidationRegistry.sol` matches the hackathon interface and fixes `postEIP712Attestation` for **new** deploys only.

**Sepolia gas (optional):** State-changing calls use **`eth_estimateGas`** with a **22% + 8k** buffer, clamped between per-tx floors and env caps, plus **EIP-1559** (`maxFeePerGas` ≈ `2 × baseFee + priority`) unless `HACKATHON_LEGACY_GAS_PRICE=true`. Disable estimation with `HACKATHON_ESTIMATE_GAS=false`. Caps: `HACKATHON_GAS_LIMIT_*` (see `.env.example`). The agent **preflights** with `simulateIntent` (free `eth_call`) before each `submitTradeIntent` so **risk rejections do not burn gas**. **RiskRouter submits** are paid by the **operator** wallet by default (`PRIVATE_KEY`); the **agent** wallet only **signs** — so you do not need Sepolia ETH on a separate `AGENT_WALLET_PRIVATE_KEY` for router txs.

### Leaderboard scoring — what you can and cannot control

| Signal | Who controls it | Practical notes |
|--------|-----------------|----------------|
| **Validation score** | **On-chain attestations** (yours + judges) | Operators may post **EIP-712 attestations** (whitelisted). Scores and **notes** (risk gate / tribunal / router) are visible on-chain and in artifacts. |
| **Reputation score** | **Judge + external raters** | Operators **cannot** self-rate (contract-enforced). **One feedback per rater per agent** — the judge bot cannot “update” your score on a second pass. |
| **Trade count** | **You (via RiskRouter)** | Shown as **lifetime** approved `TradeApproved` intents (not a rolling 1h window). More **successful** on-chain approvals → higher count. **Rejected** intents still cost gas if you submit them — preflight reduces that; **rate limits** on the router cap how fast you can grow trades. |
| **PnL / Kraken track** | **Your strategy + keys** | Per hackathon rules / leaderboard API. |

**Why others show 400+ txs and you show ~60:** they likely ran **longer**, hit **more router approvals** (within `maxTradesPerHour`), and kept the **operator wallet funded**. It is **not** because their transactions use “less gas” per opcode — each approval is similar. **Doing more approved trades uses more total ETH**, not less.

**A realistic “high score” scenario:** register once, **claim vault** if you want display capital, run `npm run run-agent` with a **funded operator** (validation + router gas), keep **`POST_VALIDATION_ATTESTATION` on** so **risk summaries** land in attestation **notes**, avoid **rejected** submits where possible (preflight + policy), and ship **checkpoints.jsonl** plus **hackathon submissions**. You cannot self-rate **reputation**; validation posts should reflect real checkpoints.

---

## Architecture

```
Your Strategy (TradingStrategy interface)
       ↓
  [On-chain] RiskRouter.validateTrade()
       ↓
  [Exchange] Kraken.placeOrder()
       ↓
  [Explainability] formatExplanation() + generateCheckpoint()
       ↓
  checkpoints.jsonl  (signed audit log)
```

---

## Prerequisites

- Node.js 20+
- Sepolia ETH ([sepoliafaucet.com](https://sepoliafaucet.com))
- Infura or Alchemy Sepolia RPC URL
- Kraken Pro account with API keys (see below)

---

## Setup

```bash
git clone <this-repo>
cd ai-trading-agent-template
npm install
cp .env.example .env
# Fill in SEPOLIA_RPC_URL, PRIVATE_KEY, KRAKEN_API_KEY, KRAKEN_API_SECRET
# Contract addresses are pre-filled for Path A (shared hackathon deploy)
```

### Kraken API key

Use **Kraken Pro** (kraken.com → Go to Kraken Pro). Go to **Settings → API** and create a key with these permissions only:

- **Funds:** Query
- **Orders and trades:** Query open orders & trades, Create & modify orders, Cancel & close orders

### Kraken CLI on Windows (and “binary not found”)

The [Kraken CLI](https://github.com/kraken-oss/kraken-cli) is the intended execution path for the hackathon track. If `npm run run-agent` errors with **Kraken CLI binary not found**:

1. Install the CLI for your OS and ensure it is on `PATH`, **or** set `KRAKEN_CLI_PATH` to the full path of `kraken.exe` (Windows).
2. If you only need **live quotes** to develop locally, do nothing extra: the template **auto-falls back** to Kraken’s **public REST** `Ticker` API when the CLI is missing. In that mode, **paper orders are simulated** (no real `kraken paper …` routing) until you install the binary.

Optional: set `KRAKEN_USE_REST=true` to use public REST for tickers always and skip spawning the CLI.

### VERIDICT in this repo (TypeScript template)

This template layers a **minimal** [Delegation Gap Sentinel](https://arxiv.org/abs/2603.10092)-style mechanical gate (pair allowlist + trust-adjusted size caps), a short **ORACLE Tribunal** audit string for checkpoints, and the existing **EIP-712 + ValidationRegistry** trail. The full system you described (PolicySpec SHA256 on-chain, IPFS provenance chain, multi-agent prosecution/defense/judges, signal engine, SAE metrics dashboard) belongs in the **Python VERIDICT** stack; this template stays Node-only but stays **on-brand** and **runnable without the CLI** for ticker data.

---

## Quickstart (Path A — template)

### 1. Contract addresses in `.env`

Do **not** deploy for the hackathon. Copy from `.env.example` (or [SHARED_CONTRACTS.md](SHARED_CONTRACTS.md)):

```env
AGENT_REGISTRY_ADDRESS=0x97b07dDc405B0c28B17559aFFE63BdB3632d0ca3
HACKATHON_VAULT_ADDRESS=0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90
RISK_ROUTER_ADDRESS=0xd6A6952545FF6E6E6681c2d15C59f9EB8F40FdBC
REPUTATION_REGISTRY_ADDRESS=0x423a9904e39537a9997fbaF0f220d79D7d545763
VALIDATION_REGISTRY_ADDRESS=0x92bF63E5C7Ac6980f237a7164Ab413BE226187F1
```

Optional: set `AGENT_NAME`, `AGENT_DESCRIPTION`, and comma-separated `AGENT_CAPABILITIES` before registering (defaults favor a **VERIDICT**-style label).

### 2. Register your agent

```bash
npm run register
```

Add the printed `AGENT_ID` to `.env` (also written to `agent-id.json`):

```env
AGENT_ID=<your agentId>
```

Use **`PRIVATE_KEY`** for the operator (gas + ERC-721 owner) and optionally **`AGENT_WALLET_PRIVATE_KEY`** for the hot wallet that signs trade intents.

### 3. (Optional) Claim vault allocation

```bash
npm run claim
```

One claim per `agentId` when the vault has capacity (~**0.05 ETH**). **Not required** for judging — you can register, use RiskRouter, and post checkpoints without claiming.

### 4. Run the agent + dashboard

In two separate terminals:

```bash
# Terminal 1 — agent loop
npm run run-agent

# Terminal 2 — VERIDICT dashboard at http://localhost:3000
npm run dashboard
```

The dashboard shows **BTC spot**, **synthetic paper equity** (replayed from signed `checkpoints.jsonl`, starting balance `PAPER_START_USD`), and **Kraken CLI `paper balance`** JSON when the binary is on `PATH`. It also includes a **LabLab submission checklist** (Kraken vs ERC-8004 vs combined). Official **Kraken Challenge PnL** is verified via your **read-only API key** on the hackathon leaderboard — not this local chart.

You'll see output like:

```
[agent] Starting agent loop
[agent] agentId:  0
[agent] Pair:     BTCUSD
[agent] Interval: 30s

[agent] BTCUSD @ $66,422.6
[2026-03-27T11:02:50.000Z] HOLD BTCUSD @ $66,422.60
  Confidence: 50%
  Reason: No clear momentum (0.09% change vs ±0.06% threshold). Holding current position.
  Market: bid=66421, ask=66421.1, spread=0.0002%, vol=2764.35

────────────────────────────────────────────────────────────────────────
CHECKPOINT — HOLD BTCUSD
  Agent:     0
  Timestamp: 2026-03-27T11:02:50.000Z
  Amount:    $0
  Price:     $66422.6
  Confidence: 50%
  Sig:       0x4f93af3b...c66c3bb31c
  Signer:    0xYourAgentWallet
────────────────────────────────────────────────────────────────────────

[agent] Checkpoint posted to ValidationRegistry: 0xa6993f19...
```

The agent warms up for the first 5 ticks (collecting price samples), then evaluates momentum. Defaults: **±0.5%** move over the window (`MOMENTUM_THRESHOLD_PCT`), **BUY** only if spread **< 0.1%** (`MOMENTUM_MAX_SPREAD_PCT`). The **~$69k** figure in the dashboard is the **live BTC/USD spot** from Kraken (REST or CLI), not agent profit. A **downward sparkline** only means the market moved down over recent checkpoints — while on **HOLD** with no position, that is not a trading loss.

**Kraken CLI (mentor alignment):** use **`BTCUSD`** as the pair, **`-o json`**, **`paper buy/sell`** for paper (no `--sandbox` flag), **`order buy` / `order sell`** for live (`KRAKEN_LIVE=true`). See `tutorial/03-kraken-connection.md`.

Every decision — including HOLDs — generates a signed checkpoint. Checkpoints append to `checkpoints.jsonl`.

### Local / fork only: deploy your own contracts

If you are **not** using hackathon judging and want a fresh deploy:

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

Paste the printed addresses into `.env`. For a local RiskRouter that supports it, you can set `RISK_ROUTER_SET_PARAMS=true` before `npm run register` to push default risk limits.

---

## Swap in your own strategy

**Built-in:** `MomentumStrategy` (momentum on recent ticks; tune `MOMENTUM_THRESHOLD_PCT` in `.env`). Swap by editing the block at the bottom of `src/agent/index.ts` or adding a class in `src/agent/strategy.ts`:

```typescript
import { MyStrategy } from "./my-strategy.js";
const strategy = new MyStrategy();
```

Your strategy only needs to implement one method:

```typescript
interface TradingStrategy {
  analyze(data: MarketData): Promise<TradeDecision>;
}
```

See `src/agent/strategy.ts` for `MomentumStrategy`.

---

## Tutorial

Step-by-step walkthrough in the `tutorial/` folder:

1. [What is ERC-8004 and why does it matter?](tutorial/01-erc8004-intro.md)
2. [Registering your agent on-chain](tutorial/02-register-agent.md)
3. [Connecting to Kraken API](tutorial/03-kraken-connection.md)
4. [The Vault and Risk Router](tutorial/04-vault-riskrouter.md)
5. [Building the explanation layer](tutorial/05-explanation-layer.md)
6. [EIP-712 signed checkpoints](tutorial/06-eip712-checkpoints.md)
7. [Using this as a reusable template](tutorial/07-reusable-template.md)

---

## Project structure

```
contracts/
  AgentRegistry.sol      # ERC-8004 agent identity registry
  HackathonVault.sol     # Capital vault with per-agent allocation
  RiskRouter.sol         # On-chain risk validation

src/
  types/index.ts         # Shared TypeScript interfaces
  agent/
    index.ts             # Main agent loop
    identity.ts          # ERC-8004 registration
    strategy.ts          # TradingStrategy interface + example strategies
  exchange/
    kraken.ts            # Kraken CLI client (paper + live)
  onchain/
    vault.ts             # Vault contract interactions
    riskRouter.ts        # RiskRouter contract interactions
  explainability/
    reasoner.ts          # Human-readable explanation formatter
    checkpoint.ts        # EIP-712 checkpoint generation + verification
  veridict/
    policyGate.ts        # Mechanical gate (allowlist, caps, trust-adjusted)
    trustState.ts        # Trust degradation counters (template subset)
    tribunalStub.ts      # Tribunal audit string (full debate in Python VERIDICT)
  dashboard/
    portfolioFromCheckpoints.ts  # Synthetic paper equity from checkpoints

scripts/
  deploy.ts              # Local/fork: deploy contracts (not for hackathon judging)
  claim-allocation.ts    # Path A: claim HackathonVault allocation
  register-agent.ts      # Register agent on-chain
  run-agent.ts           # Run the agent
  dashboard.ts           # Live web dashboard (http://localhost:3000)
```

---

## Verify a checkpoint

```typescript
import { verifyCheckpoint } from "./src/explainability/checkpoint.js";

const valid = verifyCheckpoint(
  checkpoint,
  process.env.AGENT_REGISTRY_ADDRESS!,
  11155111,
  process.env.EXPECTED_SIGNER_ADDRESS!
);
console.log(valid); // true
```

---

## License

MIT

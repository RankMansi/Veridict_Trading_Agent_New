# Part 5: Building the Explanation Layer

## Why explainability matters for trading agents

When an agent makes a trade, two questions need answers:
1. **For humans**: *Why did it do that?*: in plain language, auditable after the fact
2. **For machines**: *Can we verify it said what it claims to say?*: cryptographically

This tutorial covers the first question. Part 6 covers the second.

---

## The `reasoning` field in every decision

Every `TradeDecision` returned by your strategy must include a `reasoning` string ([`src/types/index.ts` L30–L37](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/types/index.ts#L30-L37)):

```typescript
interface TradeDecision {
  action: "BUY" | "SELL" | "HOLD";
  asset: string;
  pair: string;
  amount: number;
  confidence: number;
  reasoning: string;   // ← this is required
}
```

This is what your strategy should return for `reasoning`:

```
// Good: specific, auditable
"Price fell 1.2% over last 5 ticks while volume dropped 40% below average.
Bearish divergence — selling to reduce exposure. Risk: potential support at
$94,200 may reverse the move."

// Bad: too vague
"The market looks bad."
```

The reasoning field flows through three places automatically, once per tick (every 30 seconds by default):

| Where | What you see | Code reference |
|-------|-------------|----------------|
| **Terminal** | Printed immediately after each decision via `formatExplanation()` | [`src/agent/index.ts` L119](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L119) |
| **Terminal (checkpoint block)** | Printed again inside the signed checkpoint summary via `formatCheckpointLog()` | [`src/agent/index.ts` L174](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L174) |
| **EIP-712 signature** | `keccak256(reasoning)` is computed and included in the signed payload | [`src/explainability/checkpoint.ts` L69](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/explainability/checkpoint.ts#L69) |
| **`checkpoints.jsonl`** | Full reasoning string appended as JSON after every tick | [`src/agent/index.ts` L193](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L193) |
| **Dashboard** | Shown on each checkpoint card under the action badge | `http://localhost:3000` (poll every 5s) |

You'll see the first output in the terminal **within 30 seconds** of starting `npm run run-agent` (the agent warms up for 5 ticks collecting price samples, then starts making decisions). The default interval is set in [`src/agent/index.ts` L42](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L42) and can be overridden with `POLL_INTERVAL_MS` in `.env`.

---

## The `formatExplanation()` function

[`src/explainability/reasoner.ts` L19–L51](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/explainability/reasoner.ts#L19-L51) wraps the decision + market context into a structured log line:

```typescript
import { formatExplanation } from "./src/explainability/reasoner.js";

const explanation = formatExplanation(decision, market);
console.log(explanation);
```

Output for a BUY:

```
[2024-01-15T10:30:00.000Z] BUY BTCUSD — $100.00 @ $95,420.50
  Confidence: 78%
  Reason: Upward momentum: price rose 0.62% over last 5 ticks. Spread is tight at 0.003%. Buying.
  Market context: 24h high=96200, low=93800, VWAP=94980.20
  Spread: 0.0052% | Volume: 1204.50
```

Output for a HOLD:

```
[2026-03-27T11:02:50.000Z] HOLD BTCUSD @ $66,422.60
  Confidence: 50%
  Reason: No clear momentum (0.09% change). Holding current position.
  Market: bid=66421, ask=66421.1, spread=0.0002%, vol=2764.35
```

---

## Swapping in your own strategy (optional)

The demo runs `MomentumStrategy` — reasoning comes from price arithmetic in [`src/agent/strategy.ts`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/strategy.ts). Add a class that implements `TradingStrategy` (`analyze(market) → TradeDecision`), then instantiate it at the bottom of [`src/agent/index.ts`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts).

If you call an external model, map its output to `action`, `amount`, `confidence`, and `reasoning`. **Reasoning should reference actual market fields** (price, volume, VWAP) so checkpoints stay auditable.

---

## The `formatCheckpointLog()` function

[`src/explainability/reasoner.ts` L56–L70](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/explainability/reasoner.ts#L56-L70) — when a checkpoint is generated, `formatCheckpointLog()` produces a structured summary for the terminal:

```
────────────────────────────────────────────────────────────────────────
CHECKPOINT — BUY BTCUSD
  Agent:     0xabc...def
  Timestamp: 2024-01-15T10:30:00.000Z
  Amount:    $100
  Price:     $95420.5
  Confidence: 78%
  Reasoning: Upward momentum: price rose 0.62% over last 5 ticks...
  Sig:       0x1a2b3c4d5e6f7890...1234567890
  Signer:    0xYourWalletAddress
────────────────────────────────────────────────────────────────────────
```

---

## Reading a full tick in the terminal

Here's what one complete tick looks like, annotated:

```
[agent] BTCUSD @ $66,391.2                          ← live price fetch from Kraken

[2026-03-28T12:27:05.553Z] HOLD BTCUSD @ $66,391.20 ← formatExplanation() output
  Confidence: 50%                                    ← decision.confidence
  Reason: No clear momentum (-0.00% change).         ← decision.reasoning (from your strategy)
          Holding current position.
  Market: bid=66391.2, ask=66391.3,                 ← raw market data at decision time
          spread=0.0002%, vol=2287.42

────────────────────────────────────────────────────────────────────────
CHECKPOINT — HOLD BTCUSD                            ← formatCheckpointLog() output
  Agent:     1                                       ← agentId (ERC-721 token ID)
  Timestamp: 2026-03-28T12:27:05.000Z
  Amount:    $0                                      ← $0 for HOLD, non-zero for BUY/SELL
  Price:     $66391.2
  Confidence: 50%
  Reasoning: No clear momentum (-0.00% change).      ← same reasoning, now inside the signed payload
             Holding current position.
  Sig:       0x009aa74a5314926499...0d7940931c       ← EIP-712 signature over all of the above
  Signer:    0x13Ef924EB7408e90278B86b659960AFb00DDae61  ← agentWallet address
────────────────────────────────────────────────────────────────────────

[agent] Checkpoint posted to ValidationRegistry: 0xca62bb0d47f2b53a1a...  ← on-chain tx hash
```

The sequence within each tick is:
1. [`kraken.getTicker()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L112) — fetch live price from Kraken
2. [`strategy.analyze(market)`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L116) — strategy returns a `TradeDecision` (including `reasoning`)
3. [`formatExplanation()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L119) — prints the human-readable summary
4. [`generateCheckpoint()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L164) — signs the decision with EIP-712; reasoning is hashed into the signature
5. [`formatCheckpointLog()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L174) — prints the signed checkpoint block
6. [ValidationRegistry post](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L186) — checkpoint hash submitted on-chain to Sepolia
7. [`fs.appendFileSync()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/agent/index.ts#L193) — checkpoint appended to `checkpoints.jsonl`

---

## The checkpoints.jsonl file

Every checkpoint is appended to `checkpoints.jsonl` at the project root. Each line is a JSON object:

```json
{"agentId":"0x...","timestamp":1704067200,"action":"BUY","asset":"BTC","pair":"BTCUSD","amountUsd":100,"priceUsd":95420.5,"reasoning":"Upward momentum...","reasoningHash":"0x...","confidence":0.78,"signature":"0x...","signerAddress":"0x..."}
```

This file is your audit log. After a trading session you can:
- Review every decision and the reasoning behind it
- Verify any signature with [`verifyCheckpoint()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/explainability/checkpoint.ts#L116)
- Check that reasoning strings weren't tampered with using [`verifyReasoningIntegrity()`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/explainability/checkpoint.ts#L145)

---

## Template note

> **Why this matters:** The explanation layer is already wired into the agent loop, you don't need to call it manually. Your strategy's `reasoning` field is the only input required. The stronger and more specific your reasoning strings, the more useful your agent's audit trail becomes — for debugging, for trust, and for building reputation over time.

---

→ [Part 6: EIP-712 Signed Checkpoints](./06-eip712-checkpoints.md)
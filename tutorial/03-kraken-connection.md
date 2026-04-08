# Part 3: Connecting to Kraken CLI

## Why the CLI, not raw REST?

When building an AI trading agent, you want your code to stay focused on strategy and decision-making: not exchange plumbing. The Kraken CLI handles signing, nonces, and request shaping. Per Kraken’s docs:

- Automatic retry with exponential backoff for transient network and 5xx errors.
- Rate-limit errors are surfaced immediately with actionable fields (`retryable`, `suggestion`, `docs_url`) so the agent can decide how to proceed.

Paper trading is a **separate subcommand group** (`paper buy`, `paper sell`, …), not a `--sandbox` flag on live commands.

---

## Installing the Kraken CLI

```bash
# install script (Linux/macOS)
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh

# check out the version
kraken --version
```

Add to your `.env`:

```env
KRAKEN_API_KEY=your_api_key
KRAKEN_API_SECRET=your_api_secret
# Default in this template: paper trading. Set only when you want real orders:
# KRAKEN_LIVE=true
# Optional if the binary is not on PATH (e.g. Windows full path to kraken.exe):
# KRAKEN_CLI_PATH=
```

---

## Getting Kraken API keys

1. Log into [kraken.com](https://kraken.com) → choose **Kraken Pro** (Advanced trading)
2. Go to **Settings → API** and create a new key
3. Tick exactly these permissions:

**Funds permissions**

- ✅ Query — required for `getBalance()`

**Orders and trades**

- ✅ Query open orders & trades — required for `getOpenOrders()`
- ✅ Create & modify orders — required for `placeOrder()`
- ✅ Cancel & close orders — required if the agent needs to cancel orders

Leave everything else unchecked (no Deposit, Withdraw, Earn, Data, or WebSocket).

4. Copy the key + secret into `.env`

---

## Using the CLI directly

```bash
# Ticker — pair is positional; JSON output
kraken -o json ticker BTCUSD

# Multiple pairs
kraken -o json ticker BTCUSD ETHUSD

# Paper trading (initialize once if your CLI requires it)
kraken paper init --balance 10000 --currency USD
kraken -o json paper buy BTCUSD 0.001
kraken -o json paper sell BTCUSD 0.001
kraken -o json paper balance
kraken -o json paper history
kraken -o json paper status

# Live orders (real funds) — separate subcommands; no "order add"
kraken -o json --api-key $KRAKEN_API_KEY --api-secret $KRAKEN_API_SECRET balance
kraken -o json --api-key $KRAKEN_API_KEY --api-secret $KRAKEN_API_SECRET order buy BTCUSD 0.001 --type market
kraken -o json --api-key $KRAKEN_API_KEY --api-secret $KRAKEN_API_SECRET order buy BTCUSD 0.001 --type limit --price 95000
```

---

## How the TypeScript client wraps the CLI

[`src/exchange/kraken.ts`](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/src/exchange/kraken.ts) spawns `kraken -o json …` (argv passes `-o` and `json` as separate tokens).

Typical calls:

```typescript
await this.run(["ticker", "BTCUSD"]);
await this.run(["balance"], true); // live only — adds API key/secret when KRAKEN_LIVE=true
await this.run(["order", "buy", "BTCUSD", "0.001", "--type", "market"], true);
await this.run(["paper", "buy", "BTCUSD", "0.001"]); // paper mode (default when KRAKEN_LIVE is unset)
```

Public methods:

```typescript
const market = await kraken.getTicker("BTCUSD");
const result = await kraken.placeOrder({
  pair: "BTCUSD", type: "buy", ordertype: "market", volume: "0.001"
});
```

---

## MCP (stdio)

MCP runs over stdio — there is no `kraken mcp serve --port`.

```bash
kraken mcp
kraken mcp -s market,account,paper
kraken mcp -s all --allow-dangerous
```

Claude Desktop style config:

```json
{
  "mcpServers": {
    "kraken": {
      "command": "kraken",
      "args": ["mcp", "-s", "all", "--allow-dangerous"]
    }
  }
}
```

Wire MCP tools through your host application; this template uses `KrakenClient` subprocess calls instead of an HTTP MCP wrapper.

---

## Paper vs. live (this template)

| Setting | Behavior |
|---------|----------|
| `KRAKEN_LIVE` unset or not `true` | Uses `kraken paper …` for execution |
| `KRAKEN_LIVE=true` | Uses `kraken order buy/sell …` with API keys (real funds) |

---

## Template note

> The `KrakenClient` is the exchange adapter. Your strategy returns a `TradeDecision` — the agent loop calls `placeOrder()` automatically. **BTCUSD** is the standard pair name in Kraken CLI examples.

---

→ [Part 4: The Vault, Risk Router, and TradeIntent Pattern](./04-vault-riskrouter.md)

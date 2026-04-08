/**
 * Kraken CLI client
 *
 * Wraps the Kraken CLI binary (https://github.com/kraken-oss/kraken-cli).
 * The CLI handles signing, nonces, and request shaping. Per Kraken docs:
 *   - Automatic retry with exponential backoff for transient network and 5xx errors.
 *   - Rate-limit errors are surfaced immediately with actionable fields (retryable,
 *     suggestion, docs_url) so the agent can decide how to proceed.
 *
 * Paper trading is a **subcommand group** (`paper buy`, `paper sell`, …), not a flag.
 * Set `KRAKEN_LIVE=true` only when you intend real `order buy` / `order sell` with API keys.
 *
 * Prerequisites:
 *   1. Install the Kraken CLI from https://github.com/kraken-oss/kraken-cli
 *   2. For **live** orders: `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` in `.env`
 *   3. Default mode is **paper** (no `KRAKEN_LIVE`) — uses `kraken paper …`
 *
 * Without the CLI: ticker can fall back to Kraken public REST; paper fills are simulated
 * until you install the binary. Set `KRAKEN_USE_REST=true` to use REST for tickers only.
 *
 * MCP runs over stdio — configure Claude Desktop etc. with `command` + `args`, not HTTP.
 * See module comment block at the bottom of this file.
 *
 * CLI docs: https://github.com/kraken-oss/kraken-cli
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { KrakenOrder, KrakenOrderResult, MarketData } from "../types/index";

const execFileAsync = promisify(execFile);

/** Kraken REST / CLI internal wsname → canonical pair label (BTCUSD per Kraken CLI examples) */
const REST_PAIR_TO_LOGICAL: Record<string, string> = {
  XXBTZUSD: "BTCUSD",
  XBTUSD: "BTCUSD",
  XETHZUSD: "ETHUSD",
};

/** User-facing pair → Kraken public REST pair id */
export function toKrakenRestPair(pair: string): string {
  const p = pair.toUpperCase();
  const map: Record<string, string> = {
    BTCUSD: "XXBTZUSD",
    XBTUSD: "XXBTZUSD",
    XXBTZUSD: "XXBTZUSD",
    ETHUSD: "XETHZUSD",
    XETHZUSD: "XETHZUSD",
  };
  return map[p] || pair;
}

function defaultKrakenBin(): string {
  if (process.env.KRAKEN_CLI_PATH) return process.env.KRAKEN_CLI_PATH;
  return process.platform === "win32" ? "kraken.exe" : "kraken";
}

export class KrakenClient {
  private readonly isLiveTrading: boolean;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly krakenBin: string;
  private readonly usePublicRestOnly: boolean;
  /** CLI missing — ticker uses REST; paper orders simulated */
  private cliUnavailable = false;

  constructor(private readonly silent = false) {
    this.isLiveTrading = process.env.KRAKEN_LIVE === "true";
    this.apiKey = process.env.KRAKEN_API_KEY || "";
    this.apiSecret = process.env.KRAKEN_API_SECRET || "";
    this.krakenBin = defaultKrakenBin();
    this.usePublicRestOnly = process.env.KRAKEN_USE_REST === "true";

    if (!this.silent) {
      if (this.isLiveTrading && (!this.apiKey || !this.apiSecret)) {
        console.warn("[kraken] KRAKEN_LIVE=true but API credentials missing — live orders will fail");
      }
      if (!this.isLiveTrading) {
        console.log("[kraken] Paper trading mode (`kraken paper …`). Set KRAKEN_LIVE=true for real orders.");
      }
      if (this.usePublicRestOnly) {
        console.log("[kraken] KRAKEN_USE_REST=true — public REST for ticker; paper orders simulated without CLI");
      }
    }
  }

  private async tickerViaRest(pair: string): Promise<unknown> {
    const axios = (await import("axios")).default;
    const kpair = toKrakenRestPair(pair);
    const { data } = await axios.get<{ error: string[]; result?: Record<string, Record<string, unknown>> }>(
      "https://api.kraken.com/0/public/Ticker",
      { params: { pair: kpair }, timeout: 15000 }
    );
    if (data.error?.length) {
      throw new Error(`[kraken] REST Ticker error: ${data.error.join(", ")}`);
    }
    const result = data.result;
    if (!result || typeof result !== "object") {
      throw new Error("[kraken] REST Ticker: empty result");
    }
    const restKey = Object.keys(result)[0];
    const t = result[restKey];
    if (!t) throw new Error(`[kraken] REST Ticker: no data for ${kpair}`);
    const logical = REST_PAIR_TO_LOGICAL[restKey] || pair.toUpperCase();
    return { [logical]: t };
  }

  private cliBinCandidates(): string[] {
    const primary = this.krakenBin;
    if (process.platform === "win32" && primary.toLowerCase().endsWith(".exe")) {
      return [primary, "kraken"];
    }
    return [primary];
  }

  /**
   * Invoke `kraken -o json …` (argv: -o and json are separate tokens, equivalent to `-o json`).
   */
  private async runCli(subcommand: string[], isPrivate: boolean): Promise<unknown> {
    const args: string[] = ["-o", "json"];

    if (isPrivate && this.isLiveTrading) {
      args.push("--api-key", this.apiKey, "--api-secret", this.apiSecret);
    }

    args.push(...subcommand);

    let lastENOENT: NodeJS.ErrnoException | null = null;
    for (const bin of this.cliBinCandidates()) {
      try {
        const { stdout } = await execFileAsync(bin, args, { timeout: 15000 });
        return JSON.parse(stdout.trim());
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          lastENOENT = e;
          continue;
        }
        throw err;
      }
    }
    throw lastENOENT ?? new Error("[kraken] CLI spawn failed");
  }

  private async run(subcommand: string[], isPrivate = false): Promise<unknown> {
    const isTicker = subcommand[0] === "ticker" && subcommand.length >= 2;
    const pair = isTicker ? subcommand[1] : "";

    if (isTicker && (this.usePublicRestOnly || this.cliUnavailable)) {
      return this.tickerViaRest(pair);
    }

    if (isTicker && !this.usePublicRestOnly) {
      try {
        return await this.runCli(subcommand, isPrivate);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.cliUnavailable = true;
          console.warn(
            `[kraken] CLI not found — using public REST for ticker.\n` +
              `  Install: https://github.com/kraken-oss/kraken-cli\n` +
              `  Windows: set KRAKEN_CLI_PATH to the full path to kraken.exe\n` +
              `  Paper orders simulated until the CLI is available.`
          );
          return this.tickerViaRest(pair);
        }
        throw err;
      }
    }

    try {
      return await this.runCli(subcommand, isPrivate);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `[kraken] Kraken CLI binary not found (tried: ${this.cliBinCandidates().join(", ")}).\n` +
            `Install from https://github.com/kraken-oss/kraken-cli or set KRAKEN_CLI_PATH.\n` +
            `For tickers without the CLI, set KRAKEN_USE_REST=true (paper fills simulated).`
        );
      }
      throw err;
    }
  }

  /**
   * Fetch ticker — CLI: `kraken -o json ticker BTCUSD` (pair is positional).
   */
  async getTicker(pair: string): Promise<MarketData> {
    const canonical = pair.toUpperCase();
    const result = await this.run(["ticker", canonical]) as KrakenTickerResponse;

    type TickerEntry = {
      a?: string[]; b?: string[]; c?: string[]; v?: string[]; p?: string[]; h?: string[]; l?: string[];
      last?: string; price?: string; bid?: string; ask?: string; volume?: string; vwap?: string; high?: string; low?: string;
    };
    const data = (result.result ?? result) as Record<string, TickerEntry>;
    const aliasKey = Object.keys(data).find((k) => REST_PAIR_TO_LOGICAL[k] === canonical);
    const t =
      data[canonical] ?? (aliasKey ? data[aliasKey] : undefined) ?? data[Object.keys(data)[0]];
    if (!t) throw new Error(`[kraken] No ticker data for pair: ${canonical}`);

    return {
      pair: canonical,
      price: parseFloat(t.c?.[0] ?? t.last ?? t.price ?? "0"),
      bid: parseFloat(t.b?.[0] ?? t.bid ?? "0"),
      ask: parseFloat(t.a?.[0] ?? t.ask ?? "0"),
      volume: parseFloat(t.v?.[1] ?? t.volume ?? "0"),
      vwap: parseFloat(t.p?.[1] ?? t.vwap ?? "0"),
      high: parseFloat(t.h?.[1] ?? t.high ?? "0"),
      low: parseFloat(t.l?.[1] ?? t.low ?? "0"),
      timestamp: Date.now(),
    };
  }

  /**
   * Paper: `kraken -o json paper buy BTCUSD 0.001` or `… --type limit --price …`
   * Live:  `kraken -o json order buy BTCUSD 0.001 --type market` (with API keys)
   */
  async placeOrder(order: KrakenOrder): Promise<KrakenOrderResult> {
    const pair = order.pair.toUpperCase();

    if (!this.isLiveTrading && (this.usePublicRestOnly || this.cliUnavailable)) {
      console.warn(
        "[kraken] Simulated paper fill (no Kraken CLI). Install the CLI for real `kraken paper` routing."
      );
      return {
        txid: [`SIM-PAPER-${Date.now()}`],
        descr: { order: `${order.type} ${order.volume} ${pair} (simulated)` },
      };
    }

    let args: string[];
    if (!this.isLiveTrading) {
      args = ["paper", order.type, pair, order.volume];
      if (order.ordertype === "limit" && order.price) {
        args.push("--type", "limit", "--price", order.price);
      }
    } else {
      args = ["order", order.type === "buy" ? "buy" : "sell", pair, order.volume, "--type", order.ordertype];
      if (order.price) args.push("--price", order.price);
    }

    const result = await this.run(args, this.isLiveTrading) as KrakenOrderResponse;

    if (result.error?.length) {
      throw new Error(`[kraken] Order error: ${result.error.join(", ")}`);
    }

    const tag = this.isLiveTrading ? "LIVE" : "PAPER";
    return {
      txid: result.result?.txid ?? [`${tag}-${Date.now()}`],
      descr: result.result?.descr ?? { order: `${order.type} ${order.volume} ${pair}` },
    };
  }

  /** `kraken -o json order list` (live only — requires API keys) */
  async getOpenOrders(): Promise<Record<string, unknown>> {
    const result = await this.run(["order", "list"], true) as { result?: Record<string, unknown> };
    return result.result ?? {};
  }

  /** `kraken -o json balance` (live only) */
  async getBalance(): Promise<Record<string, string>> {
    const result = await this.run(["balance"], true) as { result?: Record<string, string> };
    return result.result ?? {};
  }

  /** `kraken -o json paper balance` — returns null if CLI fails or live mode */
  async tryPaperBalance(): Promise<unknown | null> {
    if (this.isLiveTrading) return null;
    try {
      return await this.run(["paper", "balance"], false);
    } catch {
      return null;
    }
  }

  /** `kraken -o json paper status` */
  async tryPaperStatus(): Promise<unknown | null> {
    if (this.isLiveTrading) return null;
    try {
      return await this.run(["paper", "status"], false);
    } catch {
      return null;
    }
  }
}

/**
 * ─── Kraken MCP (stdio) — not HTTP ───────────────────────────────────────────
 *
 * Run:
 *   kraken mcp
 *   kraken mcp -s market,account,paper
 *   kraken mcp -s all --allow-dangerous
 *
 * Claude Desktop / agent config example:
 *   {
 *     "mcpServers": {
 *       "kraken": {
 *         "command": "kraken",
 *         "args": ["mcp", "-s", "all", "--allow-dangerous"]
 *       }
 *     }
 *   }
 *
 * There is no `kraken mcp serve --port`; MCP speaks over stdio. Wire tools via your host app,
 * not an HTTP wrapper to localhost.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal types for CLI response shapes
// ─────────────────────────────────────────────────────────────────────────────

interface KrakenTickerResponse {
  error?: string[];
  result?: Record<string, {
    a?: string[]; b?: string[]; c?: string[]; v?: string[];
    p?: string[]; h?: string[]; l?: string[];
    last?: string; price?: string; bid?: string; ask?: string; volume?: string; vwap?: string; high?: string; low?: string;
  }>;
}

interface KrakenOrderResponse {
  error?: string[];
  result?: {
    txid: string[];
    descr: { order: string };
  };
}

/**
 * Approximate paper portfolio from signed checkpoints (when Kraken CLI paper balance is unavailable).
 * Assumes decision.amountUsd is USD notional per tick (matches agent loop). Not a substitute for
 * Kraken's ledger — use `kraken paper balance` when the CLI is installed.
 */

export interface SyntheticPortfolio {
  startUsd: number;
  usdCash: number;
  btcHeld: number;
  lastPrice: number;
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  /** Equity after each checkpoint (chronological order) */
  equitySeries: number[];
}

export function syntheticPortfolioFromCheckpoints(
  cpsNewestFirst: Array<{ action?: string; amountUsd?: number; priceUsd?: number }>,
  startUsd = 10000
): SyntheticPortfolio {
  const chronological = [...cpsNewestFirst].reverse();
  let usd = startUsd;
  let btc = 0;
  const equitySeries: number[] = [];
  let lastPrice = 0;

  for (const cp of chronological) {
    const price = Number(cp.priceUsd) || lastPrice;
    if (price > 0) lastPrice = price;
    const amt = Number(cp.amountUsd) || 0;
    if (cp.action === "BUY" && amt > 0 && lastPrice > 0) {
      btc += amt / lastPrice;
      usd -= amt;
    } else if (cp.action === "SELL" && amt > 0 && lastPrice > 0) {
      btc -= amt / lastPrice;
      usd += amt;
    }
    if (lastPrice > 0) equitySeries.push(usd + btc * lastPrice);
  }

  const equityUsd = lastPrice > 0 ? usd + btc * lastPrice : usd;
  const pnlUsd = equityUsd - startUsd;
  const pnlPct = startUsd > 0 ? (pnlUsd / startUsd) * 100 : 0;

  return {
    startUsd,
    usdCash: usd,
    btcHeld: btc,
    lastPrice,
    equityUsd,
    pnlUsd,
    pnlPct,
    equitySeries,
  };
}

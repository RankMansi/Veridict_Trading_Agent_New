/**
 * Trading Agent Dashboard — Express server with embedded UI
 *
 * Usage:
 *   npx ts-node scripts/dashboard.ts
 *
 * Opens a live dashboard at http://localhost:3000
 * Run alongside npm run run-agent in a separate terminal.
 */

import * as dotenv from "dotenv";
dotenv.config();

import express from "express";
import * as fs from "fs";
import * as path from "path";
import { KrakenClient } from "../src/exchange/kraken";
import { syntheticPortfolioFromCheckpoints } from "../src/dashboard/portfolioFromCheckpoints";

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const CHECKPOINTS_FILE = path.join(process.cwd(), "checkpoints.jsonl");

// ─── API ─────────────────────────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  const pollMs = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
  res.json({
    agentId: process.env.AGENT_ID ?? "—",
    wallet:
      process.env.HOT_WALLET_PRIVATE_KEY ? "(hot wallet set)" : process.env.PRIVATE_KEY ? "(operator wallet)" : "—",
    pair: process.env.TRADING_PAIR ?? "BTCUSD",
    liveTrading: process.env.KRAKEN_LIVE === "true",
    pollIntervalMs: Number.isFinite(pollMs) ? pollMs : 30000,
    policyMaxTradeUsd: parseFloat(process.env.POLICY_MAX_TRADE_USD || "500") || 500,
    chainId: 11155111,
    contracts: {
      agentRegistry: process.env.AGENT_REGISTRY_ADDRESS ?? null,
      hackathonVault: process.env.HACKATHON_VAULT_ADDRESS ?? null,
      riskRouter: process.env.RISK_ROUTER_ADDRESS ?? null,
      reputationRegistry: process.env.REPUTATION_REGISTRY_ADDRESS ?? null,
      validationRegistry: process.env.VALIDATION_REGISTRY_ADDRESS ?? null,
    },
  });
});

app.get("/api/checkpoints", (_req, res) => {
  if (!fs.existsSync(CHECKPOINTS_FILE)) return res.json([]);
  const raw = fs.readFileSync(CHECKPOINTS_FILE, "utf8").trim();
  if (!raw) return res.json([]);
  const all = raw.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(all.slice(-200).reverse());
});

app.get("/api/price", (_req, res) => {
  if (!fs.existsSync(CHECKPOINTS_FILE)) return res.json({ price: null });
  const raw = fs.readFileSync(CHECKPOINTS_FILE, "utf8").trim();
  if (!raw) return res.json({ price: null });
  const lines = raw.split("\n").filter(Boolean);
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    res.json({ price: last.priceUsd, timestamp: last.timestamp });
  } catch {
    res.json({ price: null });
  }
});

/** Kraken CLI paper balance/status + checkpoint-derived synthetic equity (for demos / submission). */
app.get("/api/paper-portfolio", async (_req, res) => {
  const startUsd = parseFloat(process.env.PAPER_START_USD || "10000") || 10000;
  let cpsOldestFirst: Record<string, unknown>[] = [];
  if (fs.existsSync(CHECKPOINTS_FILE)) {
    const raw = fs.readFileSync(CHECKPOINTS_FILE, "utf8").trim();
    if (raw) {
      cpsOldestFirst = raw
        .split("\n")
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Record<string, unknown>[];
    }
  }
  const newestFirst = [...cpsOldestFirst].reverse();
  const synthetic = syntheticPortfolioFromCheckpoints(newestFirst, startUsd);

  let krakenPaper: unknown = null;
  let krakenPaperStatus: unknown = null;
  if (process.env.KRAKEN_LIVE !== "true") {
    try {
      const k = new KrakenClient(true);
      krakenPaper = await k.tryPaperBalance();
      krakenPaperStatus = await k.tryPaperStatus();
    } catch {
      /* CLI missing */
    }
  }

  res.json({
    krakenPaper,
    krakenPaperStatus,
    krakenPaperAvailable: krakenPaper != null,
    synthetic,
    paperStartUsd: startUsd,
    liveTrading: process.env.KRAKEN_LIVE === "true",
  });
});

// ─── HTML ────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VERIDICT.TERMINAL</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Orbitron:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #050508;
    --bg-elevated: #0e0e12;
    --card: #12121a;
    --card-hover: #181822;
    --border: #2a2a38;
    --border-glow: rgba(57, 255, 20, 0.25);
    --text: #f4f4f5;
    --muted: #71717a;
    --dim: #52525b;
    --neon: #39ff14;
    --neon-dim: rgba(57, 255, 20, 0.12);
    --buy: #4ade80;
    --buy-glow: rgba(74, 222, 128, 0.35);
    --sell: #f87171;
    --sell-glow: rgba(248, 113, 113, 0.35);
    --hold: #a1a1aa;
    --halt: #7f1d1d;
    --halt-border: #ef4444;
    --accent-line: linear-gradient(90deg, var(--neon), transparent);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'IBM Plex Mono', 'Inter', monospace;
    font-size: 12px;
    min-height: 100vh;
    overflow-x: hidden;
  }

  body.halted .live-dot { background: var(--sell); animation: none; }
  body.halted #heartbeat-label { color: var(--sell); }

  body::before {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--accent-line);
    z-index: 9999;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .term-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 18px 28px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .brand-block { display: flex; align-items: center; gap: 14px; }

  .brand-icon {
    width: 40px; height: 40px;
    border-radius: 8px;
    background: conic-gradient(from 180deg, var(--neon), #22d3ee, #a855f7, var(--neon));
    box-shadow: 0 0 24px var(--neon-dim);
  }

  .brand-title {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--text);
  }

  .status-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }

  .pill {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    padding: 4px 10px;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .pill-ok {
    color: var(--neon);
    border: 1px solid rgba(57, 255, 20, 0.35);
    background: var(--neon-dim);
  }

  .pill-paper { color: #a5b4fc; border: 1px solid #6366f1; background: rgba(99, 102, 241, 0.12); }
  .pill-live { color: var(--bg); background: var(--neon); font-weight: 700; }

  .live-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--neon);
    margin-right: 6px;
    vertical-align: middle;
    animation: pulse 2s infinite;
    box-shadow: 0 0 8px var(--neon);
  }

  .header-actions { display: flex; align-items: center; gap: 12px; }

  .btn-halt {
    font-family: inherit;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 10px 16px;
    border-radius: 6px;
    cursor: pointer;
    background: var(--halt);
    color: #fecaca;
    border: 1px solid var(--halt-border);
    transition: transform 0.15s, box-shadow 0.15s;
  }

  .btn-halt:hover { box-shadow: 0 0 16px rgba(239, 68, 68, 0.35); }
  .btn-halt.active { background: #450a0a; color: #fff; }

  .last-update { color: var(--muted); font-size: 10px; margin-top: 4px; text-align: right; }

  .metrics-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    padding: 16px 28px;
    background: var(--bg);
  }

  @media (max-width: 1100px) {
    .metrics-row { grid-template-columns: repeat(2, 1fr); }
  }

  .metric-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    position: relative;
    overflow: hidden;
  }

  .metric-card::after {
    content: '';
    position: absolute;
    top: 0; right: 0;
    width: 48px; height: 48px;
    background: radial-gradient(circle at top right, var(--neon-dim), transparent 70%);
    pointer-events: none;
  }

  .metric-label {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .metric-value {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.35rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .metric-value.up { color: var(--buy); }
  .metric-value.down { color: var(--sell); }

  .metric-sub { font-size: 11px; margin-top: 6px; color: var(--dim); }
  .metric-sub.pnl.pos { color: var(--buy); }
  .metric-sub.pnl.neg { color: var(--sell); }
  .metric-foot { font-size: 10px; color: var(--muted); margin-top: 8px; }

  .risk-bar-wrap { margin-top: 10px; }
  .risk-bar-bg {
    height: 4px;
    background: #1f1f2e;
    border-radius: 2px;
    overflow: hidden;
  }

  .risk-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--neon), #86efac);
    border-radius: 2px;
    transition: width 0.4s ease;
    max-width: 100%;
  }

  .main-grid {
    display: grid;
    grid-template-columns: 1fr minmax(280px, 320px);
    gap: 16px;
    padding: 0 28px 28px;
    min-height: calc(100vh - 220px);
    align-items: start;
  }

  @media (max-width: 960px) {
    .main-grid { grid-template-columns: 1fr; }
  }

  .column-stream { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

  .panel-dark {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-family: 'Orbitron', sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.14em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .head-glow { color: var(--neon); margin-right: 8px; }

  .count-badge {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    color: var(--neon);
  }

  .dual-chart {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--border);
  }

  .dual-chart > div {
    background: var(--card);
    padding: 8px 10px 12px;
  }

  .mini-head {
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    margin-bottom: 6px;
  }

  .dual-chart canvas {
    width: 100% !important;
    height: 120px !important;
    display: block;
  }

  .stream-panel .feed {
    max-height: min(52vh, 560px);
    overflow-y: auto;
    padding: 0;
  }

  .feed::-webkit-scrollbar { width: 6px; }
  .feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .checkpoint-card {
    display: grid;
    grid-template-columns: 100px 1fr 120px;
    gap: 14px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
    align-items: start;
    transition: background 0.15s;
    animation: slideIn 0.35s ease;
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateX(-6px); }
    to { opacity: 1; transform: translateX(0); }
  }

  .checkpoint-card:hover { background: var(--card-hover); }

  .checkpoint-card.BUY { box-shadow: inset 3px 0 0 var(--buy); }
  .checkpoint-card.SELL { box-shadow: inset 3px 0 0 var(--sell); }
  .checkpoint-card.HOLD { box-shadow: inset 3px 0 0 var(--dim); }

  .card-left .action-big {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0.06em;
  }

  .card-left .action-big.BUY { color: var(--buy); text-shadow: 0 0 12px var(--buy-glow); }
  .card-left .action-big.SELL { color: var(--sell); text-shadow: 0 0 12px var(--sell-glow); }
  .card-left .action-big.HOLD { color: var(--hold); }

  .exec-label { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 10px; }
  .exec-price { font-size: 1rem; font-weight: 600; color: var(--text); }

  .proof-row { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

  .proof-badge {
    font-size: 9px;
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--neon-dim);
    color: var(--neon);
    border: 1px solid rgba(57, 255, 20, 0.25);
    font-family: inherit;
  }

  .checkpt-tag {
    font-size: 9px;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    color: var(--muted);
    background: var(--bg);
  }

  .card-mid .reason-text {
    font-style: italic;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.55;
    margin-bottom: 12px;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ai-label { font-size: 9px; color: var(--dim); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 6px; }

  .confidence-bar-bg {
    height: 6px;
    background: #1a1a24;
    border-radius: 3px;
    overflow: hidden;
  }

  .confidence-bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }

  .confidence-row { display: flex; align-items: center; gap: 10px; }
  .confidence-val { font-size: 11px; font-weight: 600; color: var(--neon); min-width: 36px; }

  .card-right { text-align: right; }
  .ts-label { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; }
  .ts-val { font-size: 12px; color: var(--text); margin-top: 4px; font-weight: 500; }
  .env-pill {
    display: inline-block;
    margin-top: 10px;
    font-size: 8px;
    padding: 3px 8px;
    border-radius: 20px;
    background: var(--neon-dim);
    color: var(--neon);
    letter-spacing: 0.06em;
  }

  .empty {
    padding: 48px 24px;
    text-align: center;
    color: var(--muted);
  }

  .conn-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--neon);
    animation: pulse 2s infinite;
    display: inline-block;
    margin-right: 6px;
  }

  .conn-dot.error { background: var(--sell); animation: none; }

  .column-security .sec-block {
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
  }

  .column-security .sec-block:last-child { border-bottom: none; }

  .sec-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--text);
    margin-bottom: 10px;
  }

  .sec-text { font-size: 11px; line-height: 1.6; color: var(--muted); }

  .sec-big {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--neon);
    margin: 8px 0;
  }

  .sec-agent-id {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    margin: 8px 0;
    text-align: center;
  }

  .net-line { font-size: 11px; color: var(--neon); margin-top: 8px; display: flex; align-items: center; gap: 8px; }
  .net-line .muted { color: var(--muted); }

  .decision-badge {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }

  .decision-badge.BUY { color: var(--buy); }
  .decision-badge.SELL { color: var(--sell); }
  .decision-badge.HOLD { color: var(--hold); }

  .decision-reason { margin-top: 8px; font-style: italic; max-height: 72px; overflow-y: auto; }

  .foot-note {
    padding: 12px 28px 20px;
    font-size: 10px;
    color: var(--dim);
    border-top: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .foot-note a { color: var(--neon); }

  @media (max-width: 640px) {
    .checkpoint-card { grid-template-columns: 1fr; }
    .card-right { text-align: left; }
  }
</style>
</head>
<body>

<header class="term-header">
  <div class="brand-block">
    <div class="brand-icon" aria-hidden="true"></div>
    <div>
      <div class="brand-title">VERIDICT.TERMINAL</div>
      <div class="status-pills">
        <span class="pill pill-ok">Agent: operational</span>
        <span class="pill pill-ok"><span class="live-dot" id="live-dot-header"></span><span id="heartbeat-label">Heartbeat: live</span></span>
        <span id="mode-badge" class="pill pill-paper">Paper</span>
      </div>
    </div>
  </div>
  <div class="header-actions">
    <div class="last-update"><span class="conn-dot" id="conn-dot"></span><span id="last-update-time">connecting…</span></div>
    <button type="button" class="btn-halt" id="btn-halt" title="Pause dashboard refresh">Emergency halt</button>
  </div>
</header>

<section class="metrics-row" aria-label="Key metrics">
  <div class="metric-card">
    <div class="metric-label">Total account equity</div>
    <div class="metric-value" id="metric-equity">—</div>
    <div class="metric-sub" id="metric-pnl">All-time PnL vs start —</div>
    <div class="metric-foot">Synthetic replay from signed checkpoints</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Market price</div>
    <div class="metric-value" id="metric-price">—</div>
    <div class="metric-foot" id="metric-pair-foot">BTC/USD spot feed</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Daily risk guardrail</div>
    <div class="metric-value" id="metric-risk-used">$0.00</div>
    <div class="risk-bar-wrap">
      <div class="risk-bar-bg"><div class="risk-bar-fill" id="risk-bar-fill" style="width:0%"></div></div>
    </div>
    <div class="metric-foot" id="metric-risk-cap">$0 / cap</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Signal strength</div>
    <div class="metric-value" id="metric-efficiency">—</div>
    <div class="metric-foot">Avg. confidence (last 30 checkpoints)</div>
  </div>
</section>

<div class="main-grid">
  <div class="column-stream">
    <div class="panel-dark">
      <div class="panel-head">
        <span><span class="head-glow">⌁</span> Live liquidity &amp; synthetic equity</span>
        <span class="count-badge">LIVE</span>
      </div>
      <div class="dual-chart">
        <div>
          <div class="mini-head" id="chart-price-label">Spot (checkpoints)</div>
          <canvas id="price-chart" width="400" height="120"></canvas>
        </div>
        <div>
          <div class="mini-head">Synthetic equity</div>
          <canvas id="equity-chart" width="400" height="120"></canvas>
        </div>
      </div>
    </div>
    <div class="panel-dark stream-panel">
      <div class="panel-head">
        <span><span class="head-glow">◷</span> Neural decision stream</span>
        <span class="count-badge" id="feed-count">0</span>
      </div>
      <div class="feed" id="feed">
        <div class="empty">
          <div>Waiting for agent checkpoints…</div>
          <div style="font-size:10px;margin-top:10px;color:var(--dim);">Run <code>npm run run-agent</code> in another terminal</div>
        </div>
      </div>
    </div>
  </div>
  <aside class="column-security">
    <div class="panel-dark">
      <div class="panel-head">Security protocol</div>
      <div class="sec-block">
        <div class="sec-title">Account protection</div>
        <p class="sec-text">Every trade intent is cryptographically signed (EIP-712). Checkpoints bind each decision to your on-chain agent identity (ERC-8004 registry).</p>
      </div>
      <div class="sec-block">
        <div class="sec-title">Cycle frequency</div>
        <div class="sec-big" id="sec-cycle">—</div>
        <p class="sec-text" id="sec-cycle-desc">Evaluation interval from <code>POLL_INTERVAL_MS</code>.</p>
      </div>
      <div class="sec-block">
        <div class="sec-title">On-chain pulse</div>
        <p class="sec-text" style="margin-bottom:4px;">Agent registry ID</p>
        <div class="sec-agent-id" id="sec-agent-id">#—</div>
        <div class="net-line"><span class="live-dot"></span><span id="sec-network">SEPOLIA (11155111)</span></div>
      </div>
      <div class="sec-block">
        <div class="sec-title">Latest checkpoint</div>
        <div class="decision-badge HOLD" id="decision-badge">HOLD</div>
        <p class="sec-text decision-reason" id="decision-reasoning">Waiting for first tick…</p>
        <p class="sec-text">Signer <span id="info-wallet">—</span> · Pair <span id="info-pair">—</span></p>
        <p class="sec-text">Total checkpoints <span id="info-total">0</span></p>
        <pre class="sec-text" id="pf-kraken-cli" style="display:none;margin-top:10px;max-height:100px;overflow:auto;font-size:9px;border:1px solid var(--border);padding:8px;border-radius:6px;background:var(--bg);white-space:pre-wrap;word-break:break-all;"></pre>
      </div>
    </div>
  </aside>
</div>

<footer class="foot-note">
  Provenance: <code>checkpoints.jsonl</code> · Synthetic equity uses <code>PAPER_START_USD</code>. Kraken CLI paper balance appears above when available.
  <a href="https://lablab.ai/ai-hackathons/ai-trading-agents" target="_blank" rel="noopener">Hackathon</a>
</footer>

<script>
const fmt = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = ts => {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
};
const truncate = (s) => (s && String(s).length > 12) ? String(s).slice(0, 6) + '…' + String(s).slice(-4) : (s || '—');
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

let prevPrice = null;
let priceHistory = [];
let equityHistory = [];
let statusCache = { policyMaxTradeUsd: 500, pollIntervalMs: 30000, chainId: 11155111 };
let halted = false;
let intervalCp = null;
let intervalPf = null;

function pairLabel(p) {
  const u = (p || 'BTCUSD').toUpperCase();
  if (u.startsWith('ETH')) return 'ETH/USD spot feed';
  return 'BTC/USD spot feed';
}

function formatCycle(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms % 60000 === 0) {
    const m = ms / 60000;
    return (m < 10 ? '0' + m : String(m)) + ':00 MIN';
  }
  if (ms >= 60000) return (ms / 60000).toFixed(1).replace(/\.0$/, '') + ' min';
  return Math.round(ms / 1000) + 's';
}

function proofRef(cp) {
  const h = cp.intentHash || cp.checkpointHash || cp.signature;
  return h ? truncate(h) : '—';
}

// ── Status ───────────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    statusCache = {
      policyMaxTradeUsd: s.policyMaxTradeUsd ?? 500,
      pollIntervalMs: s.pollIntervalMs ?? 30000,
      chainId: s.chainId ?? 11155111,
    };
    const aid = s.agentId ?? '—';
    document.getElementById('sec-agent-id').textContent = aid === '—' ? '#—' : '#' + aid;
    document.getElementById('info-pair').textContent = s.pair ?? 'BTCUSD';
    document.getElementById('metric-pair-foot').textContent = pairLabel(s.pair);
    document.getElementById('chart-price-label').textContent =
      (s.pair || 'BTCUSD').toUpperCase().startsWith('ETH') ? 'ETH spot (checkpoints)' : 'BTC spot (checkpoints)';
    document.getElementById('sec-network').textContent = 'SEPOLIA TESTNET (' + statusCache.chainId + ')';
    document.getElementById('sec-cycle').textContent = formatCycle(statusCache.pollIntervalMs);
    document.getElementById('sec-cycle-desc').textContent =
      'The agent evaluates markets every ' + Math.round(statusCache.pollIntervalMs / 1000) + ' seconds (' + statusCache.pollIntervalMs + ' ms).';

    const badge = document.getElementById('mode-badge');
    if (s.liveTrading) {
      badge.textContent = 'Live trading';
      badge.className = 'pill pill-live';
    } else {
      badge.textContent = 'Paper';
      badge.className = 'pill pill-paper';
    }
  } catch (e) {}
}

// ── Checkpoints ───────────────────────────────────────────────────────────────
async function loadCheckpoints() {
  if (halted) return;
  try {
    const r = await fetch('/api/checkpoints');
    const cps = await r.json();

    document.getElementById('conn-dot').className = 'conn-dot';
    document.getElementById('last-update-time').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour12: false });
    document.getElementById('feed-count').textContent = String(cps.length);
    document.getElementById('info-total').textContent = String(cps.length);

    if (cps.length === 0) {
      document.getElementById('metric-risk-used').textContent = fmt(0);
      document.getElementById('risk-bar-fill').style.width = '0%';
      const cap0 = statusCache.policyMaxTradeUsd || 500;
      document.getElementById('metric-risk-cap').textContent = fmt(0) + ' / ' + fmt(cap0);
      document.getElementById('metric-efficiency').textContent = '—';
      document.getElementById('metric-price').textContent = '—';
      document.getElementById('metric-price').className = 'metric-value';
      document.getElementById('feed').innerHTML = \`<div class="empty"><div>Waiting for agent checkpoints…</div><div style="font-size:10px;margin-top:10px;color:var(--dim);">Run <code>npm run run-agent</code> in another terminal</div></div>\`;
      return;
    }

    const cap = statusCache.policyMaxTradeUsd || 500;
    const nowSec = Date.now() / 1000;
    const dayAgo = nowSec - 86400;
    const buyVol24h = cps
      .filter(c => c.action === 'BUY' && Number(c.timestamp) >= dayAgo)
      .reduce((sum, c) => sum + (Number(c.amountUsd) || 0), 0);
    document.getElementById('metric-risk-used').textContent = fmt(buyVol24h);
    const pctRisk = cap > 0 ? Math.min(100, (buyVol24h / cap) * 100) : 0;
    document.getElementById('risk-bar-fill').style.width = pctRisk + '%';
    document.getElementById('metric-risk-cap').textContent = fmt(buyVol24h) + ' / ' + fmt(cap) + ' (24h BUY notional)';

    const last30 = cps.slice(0, 30);
    if (last30.length) {
      const avgConf = last30.reduce((s, c) => s + (Number(c.confidence) || 0), 0) / last30.length;
      document.getElementById('metric-efficiency').textContent = (avgConf * 100).toFixed(1) + '%';
    } else {
      document.getElementById('metric-efficiency').textContent = '—';
    }

    const latest = cps[0];
    const price = latest.priceUsd;
    const priceEl = document.getElementById('metric-price');
    priceEl.textContent = fmt(price);
    priceEl.className = 'metric-value';
    if (prevPrice !== null) {
      if (price > prevPrice) priceEl.classList.add('up');
      else if (price < prevPrice) priceEl.classList.add('down');
    }
    prevPrice = price;

    priceHistory = cps.slice(0, 48).map(c => c.priceUsd).reverse();
    drawChart();

    const dec = latest.action || 'HOLD';
    const decEl = document.getElementById('decision-badge');
    decEl.textContent = dec;
    decEl.className = 'decision-badge ' + dec;

    if (latest.signerAddress) {
      document.getElementById('info-wallet').textContent = truncate(latest.signerAddress);
    }

    document.getElementById('decision-reasoning').textContent = latest.reasoning ?? '—';

    const feed = document.getElementById('feed');
    feed.innerHTML = cps.map(cp => {
      const conf = Math.round((Number(cp.confidence) || 0.5) * 100);
      const barColor = cp.action === 'BUY' ? '#4ade80' : cp.action === 'SELL' ? '#f87171' : '#a1a1aa';
      const reason = esc(cp.reasoning ?? '—');
      const proof = esc(proofRef(cp));
      return \`
        <div class="checkpoint-card \${cp.action || 'HOLD'}">
          <div class="card-left">
            <div class="action-big \${cp.action || 'HOLD'}">\${cp.action || 'HOLD'}</div>
            <div class="exec-label">Exec price</div>
            <div class="exec-price">\${fmt(cp.priceUsd)}</div>
            <div class="proof-row">
              <span class="proof-badge" title="intent / digest">PROOF \${proof}</span>
              <span class="checkpt-tag">CHECKPT</span>
            </div>
          </div>
          <div class="card-mid">
            <div class="reason-text">\${reason}</div>
            <div class="ai-label">AI confidence</div>
            <div class="confidence-row">
              <div class="confidence-bar-bg" style="flex:1">
                <div class="confidence-bar-fill" style="width:\${conf}%; background:\${barColor}"></div>
              </div>
              <span class="confidence-val">\${conf}%</span>
            </div>
          </div>
          <div class="card-right">
            <div class="ts-label">Timestamp</div>
            <div class="ts-val">\${fmtTime(cp.timestamp)}</div>
            <div class="env-pill">LOCAL TERMINAL</div>
          </div>
        </div>
      \`;
    }).join('');

  } catch (e) {
    document.getElementById('conn-dot').className = 'conn-dot error';
    document.getElementById('last-update-time').textContent = 'Connection error';
  }
}

// ── Mini chart ────────────────────────────────────────────────────────────────
function drawChart() {
  const canvas = document.getElementById('price-chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  canvas.width = W;
  canvas.height = H;

  if (priceHistory.length < 2) return;

  const min = Math.min(...priceHistory);
  const max = Math.max(...priceHistory);
  const range = max - min || 1;
  const pad = 12;

  const x = i => pad + (i / (priceHistory.length - 1)) * (W - pad * 2);
  const y = v => H - pad - ((v - min) / range) * (H - pad * 2);

  ctx.clearRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(57, 255, 20, 0.14)');
  grad.addColorStop(1, 'rgba(57, 255, 20, 0)');

  ctx.beginPath();
  ctx.moveTo(x(0), y(priceHistory[0]));
  for (let i = 1; i < priceHistory.length; i++) ctx.lineTo(x(i), y(priceHistory[i]));
  ctx.lineTo(x(priceHistory.length - 1), H);
  ctx.lineTo(x(0), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(0), y(priceHistory[0]));
  for (let i = 1; i < priceHistory.length; i++) ctx.lineTo(x(i), y(priceHistory[i]));
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const lx = x(priceHistory.length - 1);
  const ly = y(priceHistory[priceHistory.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#39ff14';
  ctx.fill();
}

// ── Paper portfolio + synthetic equity chart ────────────────────────────────
async function loadPaperPortfolio() {
  if (halted) return;
  try {
    const r = await fetch('/api/paper-portfolio');
    const d = await r.json();
    const syn = d.synthetic || {};
    const eqEl = document.getElementById('metric-equity');
    eqEl.textContent = fmt(syn.equityUsd);
    const pnl = Number(syn.pnlUsd);
    const pnlPct = syn.pnlPct != null ? syn.pnlPct.toFixed(2) + '%' : '—';
    const pnlLine = document.getElementById('metric-pnl');
    const startUsd = Number(d.paperStartUsd || 10000);
    pnlLine.textContent =
      (pnl >= 0 ? '+' : '') + fmt(pnl) + ' all-time PnL (' + pnlPct + ' vs ' + fmt(startUsd) + ' start)';
    pnlLine.className = 'metric-sub pnl ' + (pnl >= 0 ? 'pos' : 'neg');
    equityHistory = Array.isArray(syn.equitySeries) ? syn.equitySeries : [];
    drawEquityChart();

    const kr = document.getElementById('pf-kraken-cli');
    if (d.krakenPaperAvailable && d.krakenPaper != null) {
      const raw = typeof d.krakenPaper === 'object' ? JSON.stringify(d.krakenPaper, null, 2) : String(d.krakenPaper);
      kr.style.display = 'block';
      kr.textContent = 'Kraken CLI paper balance:\\n' + raw;
    } else {
      kr.style.display = 'none';
    }
  } catch (e) {}
}

function drawEquityChart() {
  const canvas = document.getElementById('equity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  canvas.width = W;
  canvas.height = H;
  if (equityHistory.length < 2) return;

  const min = Math.min(...equityHistory);
  const max = Math.max(...equityHistory);
  const range = max - min || 1;
  const pad = 12;
  const up = equityHistory[equityHistory.length - 1] >= equityHistory[0];
  const stroke = up ? 'rgba(74, 222, 128, 0.95)' : 'rgba(248, 113, 113, 0.95)';

  const x = i => pad + (i / (equityHistory.length - 1)) * (W - pad * 2);
  const y = v => H - pad - ((v - min) / range) * (H - pad * 2);

  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.moveTo(x(0), y(equityHistory[0]));
  for (let i = 1; i < equityHistory.length; i++) ctx.lineTo(x(i), y(equityHistory[i]));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const lx = x(equityHistory.length - 1);
  const ly = y(equityHistory[equityHistory.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = stroke;
  ctx.fill();
}

// ── Emergency halt ───────────────────────────────────────────────────────────
function startIntervals() {
  if (intervalCp) clearInterval(intervalCp);
  if (intervalPf) clearInterval(intervalPf);
  intervalCp = setInterval(loadCheckpoints, 5000);
  intervalPf = setInterval(loadPaperPortfolio, 8000);
}

document.getElementById('btn-halt').addEventListener('click', () => {
  halted = !halted;
  document.body.classList.toggle('halted', halted);
  const btn = document.getElementById('btn-halt');
  btn.classList.toggle('active', halted);
  btn.textContent = halted ? 'Resume feed' : 'Emergency halt';
  if (halted) {
    if (intervalCp) clearInterval(intervalCp);
    if (intervalPf) clearInterval(intervalPf);
    intervalCp = intervalPf = null;
  } else {
    loadCheckpoints();
    loadPaperPortfolio();
    startIntervals();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadStatus();
  await loadCheckpoints();
  await loadPaperPortfolio();
  startIntervals();
})();
window.addEventListener('resize', () => { drawChart(); drawEquityChart(); });
</script>
</body>
</html>`;

app.get("/", (_req, res) => res.send(HTML));

app.listen(PORT, () => {
  console.log(`\n  Dashboard running at http://localhost:${PORT}`);
  console.log(`  Run "npm run run-agent" in another terminal to feed it data.\n`);
});

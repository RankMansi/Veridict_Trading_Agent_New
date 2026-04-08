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
  res.json({
    agentId:       process.env.AGENT_ID ?? "—",
    wallet:        process.env.HOT_WALLET_PRIVATE_KEY ? "(hot wallet set)" : process.env.PRIVATE_KEY ? "(operator wallet)" : "—",
    pair:          process.env.TRADING_PAIR ?? "BTCUSD",
    /** Kraken: paper subcommands by default; KRAKEN_LIVE=true for real orders */
    liveTrading:   process.env.KRAKEN_LIVE === "true",
    contracts: {
      agentRegistry:      process.env.AGENT_REGISTRY_ADDRESS ?? null,
      hackathonVault:     process.env.HACKATHON_VAULT_ADDRESS ?? null,
      riskRouter:         process.env.RISK_ROUTER_ADDRESS ?? null,
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
  res.json(all.slice(-50).reverse());
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
<title>Agent Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:        #f0f2f5;
    --bg2:       #ffffff;
    --bg3:       #f7f8fa;
    --border:    #dde1e7;
    --border2:   #c8cdd6;
    --text:      #111827;
    --muted:     #6b7280;
    --accent:    #0070f3;
    --accent2:   #0057c2;
    --buy:       #059669;
    --buy-dim:   #05966915;
    --sell:      #dc2626;
    --sell-dim:  #dc262615;
    --hold:      #6b7280;
    --hold-dim:  #6b728010;
    --gold:      #b45309;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Subtle top border accent */
  body::before {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--accent), #6366f1);
    z-index: 9999;
  }

  /* Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .logo {
    font-family: 'Syne', sans-serif;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .logo-dot {
    width: 8px; height: 8px;
    background: var(--accent);
    border-radius: 50%;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .badge {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    padding: 3px 8px;
    border-radius: 3px;
    text-transform: uppercase;
  }

  .badge-paper { background: #e0e7ff; color: #3730a3; border: 1px solid #a5b4fc; }
  .badge-live  { background: #d1fae5; color: var(--buy);  border: 1px solid #6ee7b7; }

  .last-update {
    color: var(--muted);
    font-size: 11px;
  }

  /* Grid layout */
  .grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    grid-template-rows: auto 1fr;
    gap: 1px;
    background: var(--border);
    height: calc(100vh - 53px);
  }

  .panel {
    background: var(--bg2);
    overflow: hidden;
  }

  .panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-family: 'Syne', sans-serif;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-header .count {
    background: var(--bg3);
    border: 1px solid var(--border2);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    color: var(--accent);
  }

  /* Left sidebar */
  .sidebar {
    grid-row: 1 / 3;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
  }

  /* Price hero */
  .price-hero {
    padding: 24px 16px 20px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, #e8f0fe 0%, var(--bg2) 100%);
  }

  .price-label {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }

  .price-value {
    font-family: 'Syne', sans-serif;
    font-size: 32px;
    font-weight: 800;
    color: var(--text);
    letter-spacing: -0.02em;
    line-height: 1;
    transition: color 0.3s;
  }

  .price-value.up   { color: var(--buy); }
  .price-value.down { color: var(--sell); }

  .price-change {
    font-size: 11px;
    margin-top: 6px;
    color: var(--muted);
  }

  .price-change.up   { color: var(--buy); }
  .price-change.down { color: var(--sell); }

  /* Decision display */
  .decision-display {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  .decision-label {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .decision-badge {
    font-family: 'Syne', sans-serif;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.05em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .decision-badge.BUY  { color: var(--buy); }
  .decision-badge.SELL { color: var(--sell); }
  .decision-badge.HOLD { color: var(--hold); }

  .decision-badge::before {
    content: '';
    display: block;
    width: 10px; height: 10px;
    border-radius: 50%;
  }
  .decision-badge.BUY::before  { background: var(--buy);  box-shadow: 0 0 12px var(--buy); }
  .decision-badge.SELL::before { background: var(--sell); box-shadow: 0 0 12px var(--sell); }
  .decision-badge.HOLD::before { background: var(--hold); }

  .decision-reasoning {
    margin-top: 10px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
    border-left: 2px solid var(--border2);
    padding-left: 10px;
  }

  /* Agent info */
  .agent-info {
    padding: 16px;
    flex: 1;
    border-bottom: 1px solid var(--border);
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }

  .info-row:last-child { border-bottom: none; }

  .info-key   { color: var(--muted); font-size: 11px; }
  .info-value { color: var(--text);  font-size: 11px; font-weight: 500; }
  .info-value.accent { color: var(--accent); }

  /* Mini chart */
  .chart-panel {
    padding: 0;
    height: 120px;
    position: relative;
  }

  .chart-panel canvas {
    width: 100% !important;
    height: 100% !important;
  }

  /* Main area */
  .main-area {
    display: flex;
    flex-direction: column;
  }

  /* Feed */
  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 0;
  }

  .feed::-webkit-scrollbar { width: 4px; }
  .feed::-webkit-scrollbar-track { background: transparent; }
  .feed::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  /* Checkpoint card */
  .checkpoint-card {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: 80px 1fr auto;
    gap: 12px;
    align-items: start;
    transition: background 0.15s;
    animation: slideIn 0.3s ease;
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .checkpoint-card:hover { background: var(--bg3); }

  .checkpoint-card.BUY  { border-left: 2px solid var(--buy); }
  .checkpoint-card.SELL { border-left: 2px solid var(--sell); }
  .checkpoint-card.HOLD { border-left: 2px solid var(--border2); }

  .card-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .action-pill {
    font-family: 'Syne', sans-serif;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 3px;
    letter-spacing: 0.05em;
    width: 54px;
    text-align: center;
  }

  .action-pill.BUY  { background: var(--buy-dim);  color: var(--buy);  border: 1px solid var(--buy)40; }
  .action-pill.SELL { background: var(--sell-dim); color: var(--sell); border: 1px solid var(--sell)40; }
  .action-pill.HOLD { background: var(--hold-dim); color: var(--hold); border: 1px solid var(--border2); }

  .card-time {
    font-size: 10px;
    color: var(--muted);
    text-align: center;
  }

  .card-body { min-width: 0; }

  .card-price {
    font-family: 'Syne', sans-serif;
    font-size: 15px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 4px;
  }

  .card-reasoning {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
    margin-bottom: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-confidence {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .confidence-bar-bg {
    flex: 1;
    height: 2px;
    background: var(--border2);
    border-radius: 1px;
    overflow: hidden;
  }

  .confidence-bar-fill {
    height: 100%;
    border-radius: 1px;
    background: var(--accent);
    transition: width 0.5s ease;
  }

  .confidence-val {
    font-size: 10px;
    color: var(--muted);
    width: 28px;
    text-align: right;
  }

  .card-sig {
    font-size: 10px;
    color: var(--border2);
    white-space: nowrap;
    padding-top: 2px;
    writing-mode: initial;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Empty state */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--muted);
    gap: 8px;
  }

  .empty-icon { font-size: 32px; opacity: 0.3; }

  /* Connection status */
  .conn-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--buy);
    animation: pulse 2s infinite;
    display: inline-block;
    margin-right: 6px;
  }

  .conn-dot.error { background: var(--sell); animation: none; }

  .brand-sub {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-top: 2px;
    font-family: 'JetBrains Mono', monospace;
  }

  .portfolio-block {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg3);
  }

  .portfolio-block h4 {
    font-family: 'Syne', sans-serif;
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .stat-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .stat-box {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
  }

  .stat-box .label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .stat-box .value { font-size: 14px; font-weight: 600; margin-top: 2px; }

  .pnl-pos { color: var(--buy); }
  .pnl-neg { color: var(--sell); }

  .paper-raw {
    font-size: 10px;
    color: var(--muted);
    margin-top: 8px;
    max-height: 72px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    border: 1px dashed var(--border);
    padding: 6px;
    border-radius: 4px;
    background: var(--bg2);
  }

  .submission-panel {
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, #f8fafc 0%, var(--bg2) 100%);
    padding: 14px 20px;
  }

  .submission-panel h3 {
    font-family: 'Syne', sans-serif;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text);
    margin-bottom: 10px;
  }

  .submission-panel ul {
    margin-left: 18px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.55;
  }

  .submission-panel a { color: var(--accent); }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-dot"></div>
    <div>
      <div>VERIDICT</div>
      <div class="brand-sub">Verifiable agent · EIP-712 checkpoints · Sepolia ERC-8004</div>
    </div>
  </div>
  <div class="header-right">
    <span id="mode-badge" class="badge badge-paper">PAPER</span>
    <span class="last-update"><span class="conn-dot" id="conn-dot"></span><span id="last-update-time">connecting...</span></span>
  </div>
</header>

<div class="grid">

  <!-- Sidebar -->
  <div class="sidebar panel">

    <div class="price-hero">
      <div class="price-label" id="price-label">BTC / USD spot</div>
      <div class="price-value" id="price-display">—</div>
      <div class="price-change" id="price-change"></div>
    </div>

    <div class="decision-display">
      <div class="decision-label">Last Decision</div>
      <div class="decision-badge HOLD" id="decision-badge">HOLD</div>
      <div class="decision-reasoning" id="decision-reasoning">Waiting for first tick...</div>
    </div>

    <div class="agent-info">
      <div class="panel-header" style="padding: 0 0 10px; border: none;">Agent Info</div>
      <div class="info-row">
        <span class="info-key">Agent ID</span>
        <span class="info-value accent" id="info-agent-id">—</span>
      </div>
      <div class="info-row">
        <span class="info-key">Wallet</span>
        <span class="info-value" id="info-wallet">—</span>
      </div>
      <div class="info-row">
        <span class="info-key">Pair</span>
        <span class="info-value" id="info-pair">—</span>
      </div>
      <div class="info-row">
        <span class="info-key">Network</span>
        <span class="info-value accent">Sepolia</span>
      </div>
      <div class="info-row">
        <span class="info-key">Interval</span>
        <span class="info-value">30s</span>
      </div>
      <div class="info-row">
        <span class="info-key">Checkpoints</span>
        <span class="info-value accent" id="info-total">0</span>
      </div>
    </div>

    <div class="portfolio-block">
      <h4>Paper portfolio</h4>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="label">Est. equity (USD)</div>
          <div class="value" id="pf-equity">—</div>
        </div>
        <div class="stat-box">
          <div class="label">PnL vs start</div>
          <div class="value" id="pf-pnl">—</div>
        </div>
        <div class="stat-box">
          <div class="label">USD cash (synth.)</div>
          <div class="value" id="pf-usd">—</div>
        </div>
        <div class="stat-box">
          <div class="label">BTC (synth.)</div>
          <div class="value" id="pf-btc">—</div>
        </div>
      </div>
      <div class="paper-raw" id="pf-kraken-cli" style="display:none;"></div>
      <div class="chart-caption" style="padding:8px 0 4px;font-size:10px;color:var(--muted);">
        <strong>Synthetic row</strong> replays BUY/SELL from signed checkpoints (default start <span id="pf-start">$10,000</span> — set <code>PAPER_START_USD</code> in <code>.env</code>).
        <strong>Kraken CLI</strong> row shows <code>kraken paper balance</code> when the binary is installed.
      </div>
    </div>

    <div class="panel chart-panel">
      <div class="panel-header" style="font-size:9px;padding:8px 12px;">BTC spot (checkpoints)</div>
      <canvas id="price-chart"></canvas>
      <div class="panel-header" style="font-size:9px;padding:8px 12px;">Synthetic equity curve</div>
      <canvas id="equity-chart"></canvas>
      <div class="chart-caption" style="padding:4px 8px 8px;font-size:10px;color:var(--muted);text-align:center;">
        Top: market price. Bottom: modeled paper equity from checkpoint trades only — not the official Kraken leaderboard PnL.
      </div>
    </div>

  </div>

  <!-- Main feed -->
  <div class="main-area panel">
    <div class="submission-panel">
      <h3>LabLab submission checklist (Kraken + ERC-8004)</h3>
      <ul>
        <li><strong>Kraken track:</strong> Agent uses <strong>Kraken CLI</strong> for data/execution; submit a <strong>read-only</strong> API key for PnL verification; ranked on <strong>net PnL</strong> over the window.</li>
        <li><strong>ERC-8004 track:</strong> Agent <strong>registered</strong> on shared registry; <strong>signed TradeIntents</strong> via RiskRouter; <strong>checkpoints</strong> / validation signals; judged on risk-adjusted performance + validation quality.</li>
        <li><strong>Combined:</strong> Same agent can target both — show CLI execution + on-chain identity &amp; attestations (this dashboard + <code>checkpoints.jsonl</code> + Etherscan).</li>
        <li><strong>Build in public / social</strong> engagement is a separate scored category — tag Kraken, LabLab, Surge when posting.</li>
        <li>Prize eligibility: follow current LabLab instructions (e.g. project registration) on <a href="https://lablab.ai/ai-hackathons/ai-trading-agents" target="_blank" rel="noopener">the hackathon page</a>.</li>
      </ul>
    </div>
    <div class="panel-header">
      Recent Checkpoints
      <span class="count" id="feed-count">0</span>
    </div>
    <div class="feed" id="feed">
      <div class="empty">
        <div class="empty-icon">⬡</div>
        <div>Waiting for agent data...</div>
        <div style="font-size:10px; margin-top:4px;">Run <code>npm run run-agent</code> in another terminal</div>
      </div>
    </div>
  </div>

</div>

<script>
const fmt = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = ts => {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
};
const truncate = (s, n=16) => s ? s.slice(0, 6) + '...' + s.slice(-4) : '—';

let prevPrice = null;
let priceHistory = [];
let equityHistory = [];

function pairLabel(p) {
  const u = (p || 'BTCUSD').toUpperCase();
  if (u.startsWith('ETH')) return 'ETH / USD spot';
  return 'BTC / USD spot';
}

// ── Status ───────────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    document.getElementById('info-agent-id').textContent = s.agentId ?? '—';
    document.getElementById('info-pair').textContent = s.pair ?? 'BTCUSD';
    document.getElementById('price-label').textContent = pairLabel(s.pair);

    const badge = document.getElementById('mode-badge');
    if (s.liveTrading) {
      badge.textContent = 'LIVE';
      badge.className = 'badge badge-live';
    } else {
      badge.textContent = 'PAPER';
      badge.className = 'badge badge-paper';
    }
  } catch(e) {}
}

// ── Checkpoints ───────────────────────────────────────────────────────────────
async function loadCheckpoints() {
  try {
    const r = await fetch('/api/checkpoints');
    const cps = await r.json();

    document.getElementById('conn-dot').className = 'conn-dot';
    document.getElementById('last-update-time').textContent = 'updated ' + new Date().toLocaleTimeString('en-US', { hour12: false });
    document.getElementById('feed-count').textContent = cps.length;
    document.getElementById('info-total').textContent = cps.length;

    if (cps.length === 0) return;

    // Update price
    const latest = cps[0];
    const price = latest.priceUsd;

    const priceEl = document.getElementById('price-display');
    const changeEl = document.getElementById('price-change');

    priceEl.textContent = fmt(price);
    priceEl.className = 'price-value';
    if (prevPrice !== null) {
      const pct = ((price - prevPrice) / prevPrice * 100).toFixed(3);
      if (price > prevPrice) { priceEl.classList.add('up'); changeEl.className = 'price-change up'; changeEl.textContent = '+' + pct + '%'; }
      else if (price < prevPrice) { priceEl.classList.add('down'); changeEl.className = 'price-change down'; changeEl.textContent = pct + '%'; }
      else { changeEl.textContent = '0.000%'; changeEl.className = 'price-change'; }
    }
    prevPrice = price;

    // Update chart data (newest-first cps → oldest→newest for line)
    priceHistory = cps.slice(0, 24).map(c => c.priceUsd).reverse();
    drawChart();

    // Update decision
    const dec = latest.action;
    const decEl = document.getElementById('decision-badge');
    decEl.textContent = dec;
    decEl.className = 'decision-badge ' + dec;

    // Update wallet from first checkpoint
    if (latest.signerAddress) {
      document.getElementById('info-wallet').textContent = truncate(latest.signerAddress);
    }

    document.getElementById('decision-reasoning').textContent = latest.reasoning ?? '—';

    // Render feed
    const feed = document.getElementById('feed');
    feed.innerHTML = cps.map(cp => {
      const conf = Math.round((cp.confidence ?? 0.5) * 100);
      const barColor = cp.action === 'BUY' ? 'var(--buy)' : cp.action === 'SELL' ? 'var(--sell)' : 'var(--hold)';
      return \`
        <div class="checkpoint-card \${cp.action}">
          <div class="card-action">
            <div class="action-pill \${cp.action}">\${cp.action}</div>
            <div class="card-time">\${fmtTime(cp.timestamp)}</div>
          </div>
          <div class="card-body">
            <div class="card-price">\${fmt(cp.priceUsd)}</div>
            <div class="card-reasoning" title="\${(cp.reasoning||'').replace(/"/g,'&quot;')}">\${cp.reasoning ?? '—'}</div>
            <div class="card-confidence">
              <div class="confidence-bar-bg">
                <div class="confidence-bar-fill" style="width:\${conf}%; background:\${barColor}"></div>
              </div>
              <div class="confidence-val">\${conf}%</div>
            </div>
          </div>
          <div class="card-sig">\${truncate(cp.signature ?? '')}</div>
        </div>
      \`;
    }).join('');

  } catch(e) {
    document.getElementById('conn-dot').className = 'conn-dot error';
    document.getElementById('last-update-time').textContent = 'connection error';
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

  // Fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,112,243,0.12)');
  grad.addColorStop(1, 'rgba(0,112,243,0)');

  ctx.beginPath();
  ctx.moveTo(x(0), y(priceHistory[0]));
  for (let i = 1; i < priceHistory.length; i++) ctx.lineTo(x(i), y(priceHistory[i]));
  ctx.lineTo(x(priceHistory.length - 1), H);
  ctx.lineTo(x(0), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(x(0), y(priceHistory[0]));
  for (let i = 1; i < priceHistory.length; i++) ctx.lineTo(x(i), y(priceHistory[i]));
  ctx.strokeStyle = 'rgba(0,112,243,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Last dot
  const lx = x(priceHistory.length - 1);
  const ly = y(priceHistory[priceHistory.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#0070f3';
  ctx.fill();
}

// ── Paper portfolio + synthetic equity chart ────────────────────────────────
async function loadPaperPortfolio() {
  try {
    const r = await fetch('/api/paper-portfolio');
    const d = await r.json();
    const syn = d.synthetic || {};
    document.getElementById('pf-start').textContent = '$' + Number(d.paperStartUsd || 10000).toLocaleString('en-US');
    document.getElementById('pf-equity').textContent = fmt(syn.equityUsd);
    const pnl = syn.pnlUsd;
    const pnlEl = document.getElementById('pf-pnl');
    const pnlPct = syn.pnlPct != null ? syn.pnlPct.toFixed(2) + '%' : '—';
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmt(pnl) + ' (' + pnlPct + ')';
    pnlEl.className = 'value ' + (pnl >= 0 ? 'pnl-pos' : 'pnl-neg');
    document.getElementById('pf-usd').textContent = fmt(syn.usdCash);
    document.getElementById('pf-btc').textContent = syn.btcHeld != null ? syn.btcHeld.toFixed(6) + ' BTC' : '—';
    equityHistory = Array.isArray(syn.equitySeries) ? syn.equitySeries : [];
    drawEquityChart();

    const kr = document.getElementById('pf-kraken-cli');
    if (d.krakenPaperAvailable && d.krakenPaper != null) {
      const raw = typeof d.krakenPaper === 'object' ? JSON.stringify(d.krakenPaper, null, 2) : String(d.krakenPaper);
      kr.style.display = 'block';
      kr.textContent = 'Kraken CLI paper balance:\n' + raw;
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
  const stroke = up ? 'rgba(5,150,105,0.95)' : 'rgba(220,38,38,0.95)';

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

// ── Init ──────────────────────────────────────────────────────────────────────
loadStatus();
loadCheckpoints();
loadPaperPortfolio();
setInterval(loadCheckpoints, 5000);
setInterval(loadPaperPortfolio, 8000);
window.addEventListener('resize', () => { drawChart(); drawEquityChart(); });
</script>
</body>
</html>`;

app.get("/", (_req, res) => res.send(HTML));

app.listen(PORT, () => {
  console.log(`\n  Dashboard running at http://localhost:${PORT}`);
  console.log(`  Run "npm run run-agent" in another terminal to feed it data.\n`);
});

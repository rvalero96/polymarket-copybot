// Genera docs/index.html — dashboard visual para GitHub Pages
// Uso: node src/reports/dashboard.js

import { writeFileSync, mkdirSync } from 'fs';
import { getDb, all } from '../utils/db.js';
import { CONFIG } from '../../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const money = (n, sign = false) => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (sign) return n >= 0 ? `+$${abs}` : `-$${abs}`;
  return `$${abs}`;
};

const pct = n => (n == null ? '—' : (n * 100).toFixed(1) + '%');

const addr = a => (!a ? '—' : `${a.slice(0, 6)}…${a.slice(-4)}`);

const ts = ms => {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('es-ES', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

// ── HTML sections ─────────────────────────────────────────────────────────────

function statCards(bankroll, pnlDay, pnlTotal, winRate, openPos, btc5mOpen, globalInvested, globalClosed, globalOpen) {
  const card = (label, value, colorClass = '') => `
    <div class="card">
      <div class="label">${label}</div>
      <div class="value ${colorClass}">${value}</div>
    </div>`;

  const wide = (label, value, colorClass = '') => `
    <div class="card" style="grid-column: span 2;">
      <div class="label">${label}</div>
      <div class="value ${colorClass}">${value}</div>
    </div>`;

  return `<div class="cards" style="grid-template-columns: repeat(6, 1fr);">
    ${card('Bankroll', money(bankroll))}
    ${card('P&amp;L hoy', money(pnlDay, true), cls(pnlDay))}
    ${card('P&amp;L total', money(pnlTotal, true), cls(pnlTotal))}
    ${card('Win rate', pct(winRate))}
    ${card('Copy positions', openPos)}
    ${card('5m positions', btc5mOpen)}
    ${wide('Total invertido', money(globalInvested))}
    ${wide('Cerrado', money(globalClosed))}
    ${wide('En curso', money(globalOpen))}
  </div>`;
}

function positionsTable(positions) {
  if (!positions.length) return '<p class="empty">No hay posiciones abiertas</p>';
  const rows = positions.map(p => `
    <tr>
      <td>${p.slug
        ? `<a href="https://polymarket.com/event/${p.slug}" target="_blank" rel="noopener"><code>${addr(p.market_id)}</code></a>`
        : `<code>${addr(p.market_id)}</code>`
      }</td>
      <td><span class="badge ${p.outcome === 'Yes' ? 'badge-yes' : 'badge-no'}">${p.outcome}</span></td>
      <td>${p.avg_price?.toFixed(3) ?? '—'}</td>
      <td>${money(p.size_usdc)}</td>
      <td><a href="https://polymarket.com/profile/${p.wallet}" target="_blank" rel="noopener"><code>${addr(p.wallet)}</code></a></td>
      <td>${ts(p.opened_at)}</td>
    </tr>`).join('');
  return `<table>
    <thead><tr><th>Mercado</th><th>Outcome</th><th>Precio avg</th><th>Tamaño</th><th>Wallet</th><th>Apertura</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function walletsTable(wallets) {
  if (!wallets.length) return '<p class="empty">Sin wallets activos todavía</p>';
  const rows = wallets.map((w, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><a href="https://polymarket.com/profile/${w.address}" target="_blank" rel="noopener"><code>${addr(w.address)}</code></a></td>
      <td>${w.score?.toFixed(3) ?? '—'}</td>
      <td>${pct(w.win_rate)}</td>
      <td class="${cls(w.roi)}">${pct(w.roi)}</td>
      <td class="${cls(w.pnl_total)}">${money(w.pnl_total, true)}</td>
    </tr>`).join('');
  return `<table>
    <thead><tr><th>#</th><th>Wallet</th><th>Score</th><th>Win rate</th><th>ROI</th><th>P&amp;L total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function btc5mSection(positions, stats) {
  const winRate = stats.closed > 0 ? pct(stats.wins / stats.closed) : '—';
  const posRows = positions.length
    ? positions.map(p => `
        <tr>
          <td>${p.asset}</td>
          <td><span class="badge ${p.outcome === 'UP' ? 'badge-yes' : 'badge-no'}">${p.outcome}</span></td>
          <td>${p.entry_price?.toFixed(4) ?? '—'}</td>
          <td>${money(p.size_usdc)}</td>
          <td>${ts(p.opened_at)}</td>
        </tr>`).join('')
    : `<tr><td colspan="5" class="empty">Sin posiciones abiertas</td></tr>`;

  return `
    <div class="section-header">Early-Bird 5m</div>
    <div class="cards" style="margin-bottom:1rem">
      <div class="card"><div class="label">Trades cerrados</div><div class="value">${stats.closed ?? 0}</div></div>
      <div class="card"><div class="label">Win rate</div><div class="value">${winRate}</div></div>
      <div class="card"><div class="label">P&amp;L acumulado</div><div class="value ${cls(stats.total_pnl)}">${money(stats.total_pnl, true)}</div></div>
      <div class="card"><div class="label">Total invertido</div><div class="value">${money(stats.total_invested)}</div></div>
      <div class="card"><div class="label">Cerrado</div><div class="value">${money(stats.total_closed)}</div></div>
      <div class="card"><div class="label">En curso</div><div class="value">${money(stats.total_open)}</div></div>
    </div>
    <div class="table-card">
      <h2>Posiciones abiertas — 5m</h2>
      <table>
        <thead><tr><th>Asset</th><th>Outcome</th><th>Entrada</th><th>Tamaño</th><th>Apertura</th></tr></thead>
        <tbody>${posRows}</tbody>
      </table>
    </div>`;
}

// ── Main render ───────────────────────────────────────────────────────────────

function render(d) {
  const snapsJSON = JSON.stringify(d.snapshots).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polymarket Copybot · Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f1f5f9; color: #1e293b; font-size: 14px; }

    header {
      background: #1e293b; color: white;
      padding: .875rem 2rem;
      display: flex; justify-content: space-between; align-items: center;
    }
    header h1 { font-size: 1rem; font-weight: 600; letter-spacing: -.01em; }
    header h1 span { opacity: .5; font-weight: 400; margin-left: .5rem; font-size: .85rem; }
    .updated { font-size: .75rem; opacity: .5; }

    main { max-width: 1200px; margin: 0 auto; padding: 1.5rem 2rem; }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: .75rem;
      margin-bottom: 1.25rem;
    }
    .card { background: white; border-radius: 10px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
    .label { font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; margin-bottom: .4rem; }
    .value { font-size: 1.6rem; font-weight: 700; color: #1e293b; }

    .pos { color: #10b981; }
    .neg { color: #ef4444; }

    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-bottom: 1.25rem; }
    .chart-card { background: white; border-radius: 10px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
    .chart-card h2 { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: 1rem; }
    .chart-wrap { position: relative; height: 180px; }

    .table-card { background: white; border-radius: 10px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: .75rem; }
    .table-card h2 { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: .875rem; }

    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: .4rem .75rem; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    td { padding: .55rem .75rem; border-bottom: 1px solid #f8fafc; }
    tr:last-child td { border-bottom: none; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: .8rem; background: #f1f5f9; padding: .1rem .3rem; border-radius: 3px; }

    .badge { display: inline-block; padding: .15rem .45rem; border-radius: 4px; font-size: .7rem; font-weight: 700; letter-spacing: .03em; }
    .badge-yes { background: #d1fae5; color: #065f46; }
    .badge-no  { background: #fee2e2; color: #991b1b; }

    .empty { color: #94a3b8; font-style: italic; padding: 1.5rem; text-align: center; }
    a { color: inherit; text-decoration: none; }
    a:hover code { background: #e2e8f0; }

    .section-header {
      font-size: .65rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .1em; color: #6366f1;
      border-top: 1px solid #e2e8f0; padding-top: 1.25rem;
      margin: 1.25rem 0 .875rem;
    }

    @media (max-width: 700px) {
      main { padding: 1rem; }
      .charts { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Polymarket Copybot <span>paper trading</span></h1>
    <div class="updated">Actualizado: ${d.now}</div>
  </header>

  <main>
    ${statCards(d.bankroll, d.pnlDay, d.pnlTotal, d.winRate, d.openPositions, d.btc5mOpen, d.globalInvested, d.globalClosed, d.globalOpen)}

    <div class="charts">
      <div class="chart-card">
        <h2>Bankroll (USDC)</h2>
        <div class="chart-wrap"><canvas id="bankrollChart"></canvas></div>
      </div>
      <div class="chart-card">
        <h2>P&amp;L diario (USDC)</h2>
        <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
      </div>
    </div>

    <div class="section-header">Copy Trading</div>

    <div class="cards" style="margin-bottom:1rem">
      <div class="card"><div class="label">Win rate (copy)</div><div class="value">${d.copyStats.closed_count > 0 ? pct(d.copyStats.wins / d.copyStats.closed_count) : '—'}</div></div>
      <div class="card"><div class="label">Total invertido</div><div class="value">${money(d.copyStats.total_invested)}</div></div>
      <div class="card"><div class="label">Cerrado</div><div class="value">${money(d.copyStats.total_closed)}</div></div>
      <div class="card"><div class="label">En curso</div><div class="value">${money(d.copyStats.total_open)}</div></div>
    </div>

    <div class="table-card">
      <h2>Posiciones abiertas</h2>
      ${positionsTable(d.positions)}
    </div>

    <div class="table-card">
      <h2>Wallets activos — top ${d.wallets.length}</h2>
      ${walletsTable(d.wallets)}
    </div>

    ${btc5mSection(d.btc5mPositions, d.btc5mStats)}
  </main>

  <script>
    const SNAPS = ${snapsJSON};

    const chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } },
      },
    };

    if (SNAPS.length) {
      const labels = SNAPS.map(s => s.date);

      new Chart(document.getElementById('bankrollChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data: SNAPS.map(s => s.bankroll),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99,102,241,.08)',
            fill: true,
            tension: 0.35,
            pointRadius: SNAPS.length > 20 ? 0 : 3,
            pointHoverRadius: 5,
            borderWidth: 2,
          }],
        },
        options: { ...chartDefaults },
      });

      new Chart(document.getElementById('pnlChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            data: SNAPS.map(s => s.pnlDay),
            backgroundColor: SNAPS.map(s => s.pnlDay >= 0
              ? 'rgba(16,185,129,.75)'
              : 'rgba(239,68,68,.75)'),
            borderRadius: 3,
          }],
        },
        options: { ...chartDefaults },
      });
    }
  </script>
</body>
</html>`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db  = await getDb();
  const now = new Date().toLocaleString('es-ES', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid',
  });

  const snapshots   = all(db, `SELECT date, bankroll, pnl_day FROM snapshots ORDER BY date ASC`);
  const positions   = all(db, `SELECT * FROM positions ORDER BY opened_at DESC`);
  const wallets     = all(db, `SELECT * FROM wallets WHERE active = 1 ORDER BY score DESC`);
  const btc5mPos    = all(db, `SELECT * FROM btc5m_positions ORDER BY opened_at DESC`);
  const btc5mStats  = all(db, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status != 'open' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(COALESCE(pnl, 0)) as total_pnl,
      SUM(size_usdc) as total_invested,
      SUM(CASE WHEN status != 'open' THEN size_usdc ELSE 0 END) as total_closed,
      SUM(CASE WHEN status  = 'open' THEN size_usdc ELSE 0 END) as total_open
    FROM btc5m_trades
  `)[0] ?? { total: 0, closed: 0, wins: 0, total_pnl: 0, total_invested: 0, total_closed: 0, total_open: 0 };

  const copyStats = all(db, `
    SELECT
      SUM(size_usdc)                                                        AS total_invested,
      SUM(CASE WHEN status = 'closed' THEN size_usdc ELSE 0 END)           AS total_closed,
      SUM(CASE WHEN status = 'open'   THEN size_usdc ELSE 0 END)           AS total_open,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)                   AS closed_count,
      SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END)      AS wins
    FROM trades
  `)[0] ?? { total_invested: 0, total_closed: 0, total_open: 0, closed_count: 0, wins: 0 };

  const latest  = snapshots[snapshots.length - 1];
  const prev    = snapshots[snapshots.length - 2];
  const bankroll = latest?.bankroll ?? CONFIG.PAPER_BANKROLL;
  const pnlTotal = bankroll - CONFIG.PAPER_BANKROLL;
  const pnlDay   = prev ? bankroll - prev.bankroll : (latest?.pnl_day ?? 0);

  const winSnap = all(db, `SELECT win_rate FROM snapshots ORDER BY date DESC LIMIT 1`)[0];

  const data = {
    now,
    bankroll,
    pnlTotal,
    pnlDay,
    winRate:      winSnap?.win_rate ?? 0,
    openPositions: positions.length,
    btc5mOpen:    btc5mPos.length,
    snapshots:    snapshots.map(s => ({ date: s.date, bankroll: s.bankroll, pnlDay: s.pnl_day })),
    positions,
    wallets,
    btc5mPositions: btc5mPos,
    btc5mStats,
    copyStats,
    globalInvested: (copyStats.total_invested ?? 0) + (btc5mStats.total_invested ?? 0),
    globalClosed:   (copyStats.total_closed   ?? 0) + (btc5mStats.total_closed   ?? 0),
    globalOpen:     (copyStats.total_open     ?? 0) + (btc5mStats.total_open     ?? 0),
  };

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/index.html', render(data));
  console.log(`Dashboard → docs/index.html [${new Date().toISOString()}]`);
}

main().catch(err => {
  console.error('dashboard:fatal', err.message);
  process.exit(1);
});

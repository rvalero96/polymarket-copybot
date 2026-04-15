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

const pct     = n => (n == null ? '—' : (n * 100).toFixed(1) + '%');
const addr    = a => (!a ? '—' : `${a.slice(0, 6)}…${a.slice(-4)}`);
const cls     = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
// Border class: green if positive, red if negative, empty (keeps --accent) if null/zero
const bcls    = n => (n == null ? '' : n > 0 ? 'border-pos' : n < 0 ? 'border-neg' : '');
const winBcls = n => (n == null ? '' : n >= 0.5 ? 'border-pos' : 'border-neg');
const winCls  = n => (n == null ? '' : n >= 0.5 ? 'pos' : 'neg');
const ts      = ms => {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('es-ES', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

// Humanizes a btc5m market slug like "eth-updown-5m-1744533000"
// into "Ethereum Up or Down - April 13, 1:30AM-1:35AM ET"
const ASSET_NAMES = { btc: 'Bitcoin', eth: 'Ethereum', sol: 'Solana', xrp: 'XRP' };
const slugLabel = slug => {
  const m = slug.match(/^(btc|eth|sol|xrp)-updown-5m-(\d{9,10})$/i);
  if (!m) return slug.replace(/-\d{9,}$/, '').replace(/-/g, ' ');
  const asset  = ASSET_NAMES[m[1].toLowerCase()] ?? m[1].toUpperCase();
  const tsMs   = parseInt(m[2]) * 1000;
  const start  = new Date(tsMs);
  const end    = new Date(tsMs + 5 * 60 * 1000);
  const fmtDate = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const fmtTime = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
    .replace(' AM', 'AM').replace(' PM', 'PM');
  return `${asset} Up or Down - ${fmtDate(start)}, ${fmtTime(start)}-${fmtTime(end)} ET`;
};

const ASSET_LOGO = {
  BTC: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
  ETH: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  SOL: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
  XRP: 'https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png',
};
const assetCell = name => name
  ? `<span class="asset-cell"><img class="asset-logo" src="${ASSET_LOGO[name] ?? ''}" alt="${name}" onerror="this.style.display='none'"><span>${name}</span></span>`
  : '—';

const outcomeBadge = o => {
  if (o === 'Yes' || o === 'UP')   return `<span class="badge-yes">${o}</span>`;
  if (o === 'No'  || o === 'DOWN') return `<span class="badge-no">${o}</span>`;
  return `<span class="badge-option">${o}</span>`;
};

// Highlights the distinguishing entity within a market title.
// Only applied when isMulti=true (market_slug !== event slug → sub-market of a multi-option event).
// Extraction order:
//   1. Non-standard outcome stored in DB (e.g. "Bitcoin" for token-based markets)
//   2. Date expression after "by" or "before" (e.g. "December 31, 2026")
//   3. Capitalized proper-noun subject after "Will [the]" (teams, people, assets)
const SIMPLE_OUTCOMES = new Set(['Yes', 'No', 'UP', 'DOWN']);
const highlightEntity = (title, outcome, isMulti) => {
  if (!title || !isMulti) return title;
  let entity = null;
  let m;
  if (outcome && !SIMPLE_OUTCOMES.has(outcome)) {
    entity = outcome;
  } else {
    // Date after "by" or "before": e.g. "by December 31, 2026"
    m = title.match(/\b(?:by|before)\s+([A-Z][a-z]+ \d+(?:,\s*\d{4})?|\d{4})/);
    if (m) entity = m[1];
  }
  if (!entity) {
    // Capitalized proper-noun subject after "Will [the ]"
    m = title.match(/^Will (?:the )?([A-Z][A-Za-z0-9.']*(?:\s+[A-Z][A-Za-z0-9.']*)*)/);
    if (m) entity = m[1];
  }
  if (!entity) return title;
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(escaped, 'i'), match => `<span class="outcome-entity">${match}</span>`);
};

// stat card with tooltip and optional border-color override
const statCard = (label, value, colorClass = '', tip = '', borderClass = '') => `
  <div class="stat-card ${borderClass}">
    <div class="stat-label">${label}</div>
    <div class="stat-value ${colorClass}">${value}</div>
    ${tip ? `<div class="tip">${tip}</div>` : ''}
  </div>`;

// ── Tables ────────────────────────────────────────────────────────────────────

function positionsTable(positions) {
  const isMulti  = p => !!(p.market_slug && p.slug && p.market_slug !== p.slug);
  const posLabel  = p => p.title ? highlightEntity(p.title, p.outcome, isMulti(p)) : `<code>${addr(p.market_id)}</code>`;
  const rows = positions.length
    ? positions.map(p => `
      <tr>
        <td>${p.slug
          ? `<a href="https://polymarket.com/event/${p.slug}" target="_blank" rel="noopener">${posLabel(p)}</a>`
          : posLabel(p)
        }</td>
        <td>${outcomeBadge(p.outcome)}</td>
        <td class="num">${p.avg_price?.toFixed(3) ?? '—'}</td>
        <td class="num">${money(p.size_usdc)}</td>
        <td><a href="https://polymarket.com/profile/${p.wallet}" target="_blank" rel="noopener">${p.wallet_name ? p.wallet_name : `<code>${p.wallet}</code>`}</a></td>
        <td>${ts(p.opened_at)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty">No hay posiciones abiertas</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Posiciones abiertas</span>
      <span class="table-badge" id="badge-pos">${positions.length} ABIERTAS</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="sortable" data-col="0"><div class="th-inner"><span>Mercado</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="0" data-filter-type="text" data-filter-ph="Buscar mercado…" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Outcome</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="1" data-filter-type="select" data-filter-opts="Todos:|Yes:yes|No:no" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="2"><div class="th-inner"><span>Precio avg</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Tamaño</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>Wallet</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="4" data-filter-type="text" data-filter-ph="Buscar wallet…" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>Apertura</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-pos">${rows}</tbody>
    </table></div>
  </div>`;
}

function walletsTable(wallets) {
  const rows = wallets.length
    ? wallets.map((w, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><a href="https://polymarket.com/profile/${w.address}" target="_blank" rel="noopener">${w.name ? w.name : `<code>${w.address}</code>`}</a></td>
        <td class="num">${w.score?.toFixed(3) ?? '—'}</td>
        <td>${pct(w.win_rate)}</td>
        <td class="${cls(w.roi)}">${pct(w.roi)}</td>
        <td class="${cls(w.pnl_total)}">${money(w.pnl_total, true)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty">Sin wallets activos todavía</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Wallets seguidos</span>
      <span class="table-badge" id="badge-wallets">TOP ${wallets.length}</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th data-col="0"><div class="th-inner"><span>#</span></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Wallet</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="1" data-filter-type="text" data-filter-ph="Buscar wallet…" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="2"><div class="th-inner"><span>Score</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Win rate</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>ROI</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>P&amp;L total</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-wallets">${rows}</tbody>
    </table></div>
  </div>`;
}

function tradeLogTable(trades) {
  const statusBadge = t => {
    if (t.status === 'open')     return `<span class="tl-badge tl-open">Abierta</span>`;
    if (t.status === 'resolved') return `<span class="tl-badge tl-resolved">Resuelta</span>`;
    return `<span class="tl-badge tl-closed">Cerrada</span>`;
  };

  const stratBadge = t => t.strategy === 'copy'
    ? `<span class="tl-badge tl-copy">Copy</span>`
    : `<span class="tl-badge tl-5m">5m · ${t.asset ?? ''}</span>`;

  const isMulti     = t => !!(t.market_slug && t.slug && t.market_slug !== t.slug);
  const mercadoText = t => t.title
    ? highlightEntity(t.title, t.outcome, isMulti(t))
    : (t.slug ? slugLabel(t.slug) : `<code>${addr(t.market_id)}</code>`);
  const mercadoLink = t => t.slug
    ? `<a href="https://polymarket.com/event/${t.slug}" target="_blank" rel="noopener">${mercadoText(t)}</a>`
    : mercadoText(t);

  const rows = trades.length
    ? trades.map(t => `
      <tr>
        <td class="num" style="white-space:nowrap">${ts(t.opened_at)}</td>
        <td>${stratBadge(t)}</td>
        <td>${mercadoLink(t)}</td>
        <td>${assetCell(t.asset)}</td>
        <td>${outcomeBadge(t.outcome)}</td>
        <td class="num">${money(t.size_usdc)}</td>
        <td class="num neg">${money(t.cost)}</td>
        <td>${statusBadge(t)}</td>
        <td class="num ${cls(t.pnl)}">${t.pnl != null ? money(t.pnl, true) : '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="9" class="empty">Sin operaciones registradas</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Registro de operaciones</span>
      <span class="table-badge" id="badge-tradelog">${trades.length} OPS</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="sortable" data-col="0"><div class="th-inner"><span>Fecha</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Estrategia</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="1" data-filter-type="select" data-filter-opts="Todas:|Copy:copy|5m:5m" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="2"><div class="th-inner"><span>Mercado</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="2" data-filter-type="text" data-filter-ph="Buscar mercado…" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Asset</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="3" data-filter-type="select" data-filter-opts="Todos:|BTC:btc|ETH:eth|SOL:sol|XRP:xrp" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>Outcome</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="4" data-filter-type="select" data-filter-opts="Todos:|Yes:yes|No:no|UP:up|DOWN:down" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>Inversión</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="6"><div class="th-inner"><span>Coste</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="7"><div class="th-inner"><span>Estado</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="7" data-filter-type="select" data-filter-opts="Todos:|Abierta:abierta|Cerrada:cerrada|Resuelta:resuelta" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="8"><div class="th-inner"><span>P&amp;L</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-tradelog">${rows}</tbody>
    </table></div>
  </div>`;
}

function btc5mTable(positions) {
  const posLabel  = p => p.title ?? (p.slug ? slugLabel(p.slug) : `<code>${addr(p.market_id)}</code>`);
  const rows = positions.length
    ? positions.map(p => `
      <tr>
        <td>${assetCell(p.asset)}</td>
        <td>${p.slug
          ? `<a href="https://polymarket.com/event/${p.slug}" target="_blank" rel="noopener">${posLabel(p)}</a>`
          : posLabel(p)
        }</td>
        <td>${outcomeBadge(p.outcome)}</td>
        <td class="num">${p.entry_price?.toFixed(4) ?? '—'}</td>
        <td class="num">${money(p.size_usdc)}</td>
        <td>${ts(p.opened_at)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty">Sin posiciones abiertas</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Posiciones abiertas — 5m</span>
      <span class="table-badge" id="badge-btc5m">${positions.length} ACTIVAS</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="sortable" data-col="0"><div class="th-inner"><span>Asset</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="0" data-filter-type="select" data-filter-opts="Todos:|BTC:btc|ETH:eth|SOL:sol|XRP:xrp" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Mercado</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="2"><div class="th-inner"><span>Outcome</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="2" data-filter-type="select" data-filter-opts="Todos:|UP:up|DOWN:down" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Entrada</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>Tamaño</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>Apertura</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-btc5m">${rows}</tbody>
    </table></div>
  </div>`;
}

// ── Arbitrage tables ──────────────────────────────────────────────────────────

const stratBadgeArb = s => {
  const map = {
    monotonicity: ['#f59e0b', 'Monoton.'],
    basket:       ['#818cf8', 'Basket'],
    spread:       ['#34d399', 'Spread'],
  };
  const [color, label] = map[s] ?? ['#ADAAAA', s];
  return `<span style="display:inline-block;padding:0.15rem 0.4rem;border-radius:0.2rem;font-size:0.6rem;font-weight:700;background:${color}22;color:${color};letter-spacing:0.04em">${label}</span>`;
};

function arbOpportunitiesTable(opps) {
  const rows = opps.length
    ? opps.map(o => {
        const legs     = typeof o.legs === 'string' ? JSON.parse(o.legs) : o.legs;
        const legHtml  = legs.map(l =>
          `<div style="font-size:0.6rem;color:var(--muted)">${l.side.toUpperCase()} ${l.outcome} @ ${l.price?.toFixed(3) ?? '—'}</div>`
        ).join('');
        const statusCls = o.status === 'open' ? 'tl-open' : o.status === 'traded' ? 'tl-copy' : o.status === 'expired' ? '' : 'tl-resolved';
        const statusLbl = o.status === 'open' ? 'Abierta' : o.status === 'traded' ? 'Operada' : o.status === 'expired' ? 'Expirada' : 'Resuelta';
        return `
        <tr>
          <td>${stratBadgeArb(o.strategy)}</td>
          <td style="max-width:280px;font-size:0.7rem">${o.description}</td>
          <td>${legHtml}</td>
          <td class="num pos">${pct(o.expected_profit)}</td>
          <td class="num">${(o.confidence * 100).toFixed(0)}%</td>
          <td><span class="tl-badge ${statusCls}">${statusLbl}</span></td>
          <td class="num" style="white-space:nowrap">${ts(o.detected_at)}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="7" class="empty">Sin oportunidades detectadas todavía</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Scanner de oportunidades</span>
      <span class="table-badge" id="badge-arb-opps">${opps.length} DETECTADAS</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="sortable" data-col="0"><div class="th-inner"><span>Estrategia</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="0" data-filter-type="select" data-filter-opts="Todas:|Monoton.:monoton|Basket:basket|Spread:spread" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Descripción</span><span class="sort-icon">⇅</span></div></th>
        <th data-col="2"><div class="th-inner"><span>Piernas</span></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Beneficio esp.</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>Confianza</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>Estado</span><span class="sort-icon">⇅</span><button class="th-filter-btn" data-filter-col="5" data-filter-type="select" data-filter-opts="Todos:|Abierta:abierta|Operada:operada|Expirada:expirada|Resuelta:resuelta" title="Filtrar"><span class="ms" style="font-size:0.7rem">filter_list</span></button></div></th>
        <th class="sortable" data-col="6"><div class="th-inner"><span>Detectada</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-arb-opps">${rows}</tbody>
    </table></div>
  </div>`;
}

function arbTradesTable(trades) {
  const rows = trades.length
    ? trades.map(t => `
      <tr>
        <td>${stratBadgeArb(t.strategy)}</td>
        <td><code style="font-size:0.65rem">${addr(t.market_id)}</code></td>
        <td class="num">${t.leg_index + 1}</td>
        <td><span class="${t.outcome === 'Yes' || t.outcome === 'UP' ? 'badge-yes' : 'badge-no'}">${t.outcome}</span></td>
        <td class="num">${t.price?.toFixed(3) ?? '—'}</td>
        <td class="num">${money(t.size_usdc)}</td>
        <td class="num" style="white-space:nowrap">${ts(t.opened_at)}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="empty">Sin posiciones de arbitraje abiertas</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Piernas abiertas</span>
      <span class="table-badge" id="badge-arb-trades">${trades.length} ABIERTAS</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="sortable" data-col="0"><div class="th-inner"><span>Estrategia</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Mercado</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="2"><div class="th-inner"><span>Pierna</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Outcome</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>Precio</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>Tamaño</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="6"><div class="th-inner"><span>Apertura</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-arb-trades">${rows}</tbody>
    </table></div>
  </div>`;
}

function arbHistoryTable(trades) {
  const rows = trades.length
    ? trades.map(t => `
      <tr>
        <td>${stratBadgeArb(t.strategy)}</td>
        <td><code style="font-size:0.65rem">${addr(t.market_id)}</code></td>
        <td><span class="${t.outcome === 'Yes' || t.outcome === 'UP' ? 'badge-yes' : 'badge-no'}">${t.outcome}</span></td>
        <td class="num">${t.price?.toFixed(3) ?? '—'}</td>
        <td class="num">${money(t.size_usdc)}</td>
        <td class="num ${cls(t.pnl)}">${t.pnl != null ? money(t.pnl, true) : '—'}</td>
        <td class="num" style="white-space:nowrap">${ts(t.closed_at)}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="empty">Sin operaciones de arbitraje cerradas</td></tr>`;

  return `<div class="table-panel">
    <div class="table-header">
      <span class="table-title">Historial de arbitraje</span>
      <span class="table-badge" id="badge-arb-hist">${trades.length} CERRADAS</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="sortable" data-col="0"><div class="th-inner"><span>Estrategia</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="1"><div class="th-inner"><span>Mercado</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="2"><div class="th-inner"><span>Outcome</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="3"><div class="th-inner"><span>Precio entrada</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="4"><div class="th-inner"><span>Tamaño</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="5"><div class="th-inner"><span>P&amp;L</span><span class="sort-icon">⇅</span></div></th>
        <th class="sortable" data-col="6"><div class="th-inner"><span>Cierre</span><span class="sort-icon">⇅</span></div></th>
      </tr></thead>
      <tbody id="tbl-arb-hist">${rows}</tbody>
    </table></div>
  </div>`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(d) {
  const snapsJSON = JSON.stringify(d.snapshots).replace(/</g, '\\u003c');
  const cs = d.copyStats;
  const bs = d.btc5mStats;

  const pnlPct = `${d.pnlTotal >= 0 ? '+' : ''}${((d.pnlTotal / CONFIG.PAPER_BANKROLL) * 100).toFixed(1)}%`;
  const utilPct = d.portfolio > 0 ? ((d.globalOpen / d.portfolio) * 100).toFixed(1) : '0.0';

  const pnlLeftAccent = d.pnlTotal > 0
    ? 'border-left: 2px solid rgba(0,255,163,0.4)'
    : d.pnlTotal < 0
      ? 'border-left: 2px solid rgba(255,77,77,0.4)'
      : 'border-left: 2px solid rgba(99,102,241,0.25)';

  const winLeftAccent = d.winRate != null && d.winRate >= 0.5
    ? 'border-left: 2px solid rgba(0,255,163,0.4)'
    : d.winRate != null
      ? 'border-left: 2px solid rgba(255,77,77,0.4)'
      : 'border-left: 2px solid rgba(99,102,241,0.25)';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polymarket Copybot · Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:          #0D0D0D;
      --surface-low: #131313;
      --surface:     #1a1919;
      --surface-hi:  #201f1f;
      --primary:     #00FFA3;
      --primary-bg:  rgba(0,255,163,0.08);
      --tertiary:    #FF4D4D;
      --tertiary-bg: rgba(255,77,77,0.08);
      --text:        #ffffff;
      --muted:       #ADAAAA;
      --border:      rgba(72,72,71,0.15);
      --sidebar:     256px;
      --topnav:      64px;
      --statusbar:   32px;
    }

    html, body { height: 100%; }
    body {
      background: var(--bg); color: var(--text);
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 13px; line-height: 1.5;
    }

    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: #484847; border-radius: 2px; }

    .ms {
      font-family: 'Material Symbols Outlined';
      font-style: normal; font-weight: 300; line-height: 1;
      font-variation-settings: 'FILL' 0,'wght' 300,'GRAD' 0,'opsz' 24;
      display: inline-block; vertical-align: middle;
    }

    /* ── Top Nav ── */
    .topnav {
      position: fixed; top: 0; left: 0; right: 0; height: var(--topnav);
      background: var(--bg); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 1.5rem; z-index: 100;
    }
    .topnav-brand {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1rem; font-weight: 700; letter-spacing: -0.02em; color: var(--primary);
    }
    .topnav-right { font-size: 0.6rem; color: var(--muted); opacity: 0.55; font-family: monospace; }

    /* ── Sidebar ── */
    .sidebar {
      position: fixed; left: 0; top: var(--topnav); bottom: 0;
      width: var(--sidebar); background: #000;
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column; z-index: 90;
      overflow: hidden;
    }
    .sidebar-brand-area { padding: 1.25rem 1.5rem 1rem; flex-shrink: 0; }
    .sidebar-brand {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.6rem; font-weight: 900; letter-spacing: 0.18em;
      text-transform: uppercase; color: var(--primary);
    }
    .sidebar-ver { font-size: 0.55rem; color: var(--muted); opacity: 0.4; margin-top: 2px; font-family: monospace; }
    .sidebar-nav { flex: 1; }
    .nav-item {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.7rem 1.5rem; color: var(--muted); cursor: pointer;
      transition: all 0.15s; font-size: 0.8rem; font-weight: 500;
      border-right: 2px solid transparent; text-decoration: none;
      user-select: none;
    }
    .nav-item:hover { background: rgba(19,19,19,0.7); color: var(--text); }
    .nav-item.active { color: var(--primary); background: var(--surface-low); border-right-color: var(--primary); }
    .sidebar-footer { padding: 1rem 1.5rem 1.5rem; flex-shrink: 0; }
    .sf-card {
      background: rgba(32,31,31,0.4); border: 1px solid rgba(72,72,71,0.1);
      border-radius: 0.5rem; padding: 0.875rem;
    }
    .sf-label { font-size: 0.55rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 0.5rem; }
    .prog-bar { width: 100%; height: 2px; background: #000; border-radius: 999px; overflow: hidden; }
    .prog-fill { height: 100%; background: var(--primary); width: 65%; }
    .sf-meta { display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.55rem; color: var(--primary); font-family: monospace; }

    /* ── Main & Tabs ── */
    .main {
      margin-left: var(--sidebar);
      height: calc(100vh - var(--topnav));
      margin-top: var(--topnav);
      overflow-y: auto;
      padding: 1.25rem 1.25rem calc(var(--statusbar) + 1.25rem);
    }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    /* ── Metrics Header ── */
    .metrics-hd {
      display: grid; grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: 0.75rem; margin-bottom: 0.75rem;
    }
    .metric-hero {
      background: var(--surface-low); border-radius: 0.5rem;
      padding: 1.25rem; position: relative;
      min-height: 130px; display: flex; flex-direction: column; justify-content: flex-end;
    }
    /* icon clipped separately so tooltip can overflow */
    .hero-icon-clip {
      position: absolute; inset: 0; overflow: hidden;
      border-radius: 0.5rem; pointer-events: none;
    }
    .hero-icon {
      position: absolute; top: 0.75rem; right: 0.75rem;
      font-size: 4.5rem !important; color: var(--primary); opacity: 0.06; line-height: 1;
    }
    .hero-label { font-size: 0.58rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 0.4rem; }
    .hero-value {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 2.1rem; font-weight: 700; letter-spacing: -0.03em; line-height: 1;
      background: linear-gradient(135deg, #B1FFCE 0%, #00FFA3 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .hero-badge {
      display: inline-block; margin-top: 0.75rem; padding: 0.15rem 0.45rem;
      background: var(--primary-bg); color: var(--primary);
      font-size: 0.55rem; font-weight: 700; border-radius: 0.25rem; letter-spacing: 0.05em;
    }
    .hero-badge.neg-badge { background: var(--tertiary-bg); color: var(--tertiary); }

    .metric-card {
      background: var(--surface-low); border-radius: 0.5rem; padding: 1.25rem;
      display: flex; flex-direction: column; justify-content: space-between;
      position: relative;
    }
    .mc-label { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); }
    .mc-value { font-family: 'Space Grotesk', sans-serif; font-size: 1.25rem; font-weight: 700; margin-top: 0.4rem; }
    .mc-sub { font-size: 0.58rem; color: var(--muted); opacity: 0.6; margin-top: 0.2rem; }

    /* ── Charts ── */
    .charts-row { display: grid; grid-template-columns: 2fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem; }
    .chart-panel {
      background: #000; border-radius: 0.75rem;
      border: 1px solid var(--border); padding: 1.25rem;
    }
    .cp-hd { margin-bottom: 1rem; }
    .cp-title { font-family: 'Space Grotesk', sans-serif; font-size: 0.85rem; font-weight: 700; margin-bottom: 0.15rem; }
    .cp-sub { font-size: 0.58rem; color: var(--muted); }
    .chart-wrap { position: relative; height: 180px; }

    /* ── Section Dividers ── */
    .sec-div { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0 0.75rem; }
    .sec-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent, var(--primary)); flex-shrink: 0; }
    .sec-label { font-size: 0.55rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.18em; color: var(--accent, var(--primary)); white-space: nowrap; }
    .sec-line { flex: 1; height: 1px; background: var(--border); }

    /* ── Stats Grid ── */
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; margin-bottom: 0.75rem; }
    .stat-card {
      background: var(--surface-low); border-radius: 0.5rem;
      padding: 0.875rem 1rem;
      border-top: 2px solid var(--accent, #6366f1);
      position: relative; cursor: default;
    }
    /* Border color overrides based on value */
    .stat-card.border-pos { border-top-color: var(--primary); }
    .stat-card.border-neg { border-top-color: var(--tertiary); }

    .stat-label { font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.4rem; }
    .stat-value { font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; font-weight: 700; }

    /* ── Tooltips ── */
    .tip {
      position: absolute;
      top: calc(100% + 6px); left: 0;
      min-width: 220px; max-width: 260px;
      background: #1a1919;
      border: 1px solid rgba(72,72,71,0.5);
      border-radius: 0.5rem;
      padding: 0.6rem 0.75rem;
      font-size: 0.65rem; font-family: 'Inter', sans-serif;
      line-height: 1.6; color: var(--muted);
      z-index: 999;
      pointer-events: none;
      opacity: 0; visibility: hidden;
      transition: opacity 0.15s, visibility 0.15s;
      font-weight: 400;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    /* Right-align tooltip for last column to avoid overflow */
    .stats-grid .stat-card:nth-child(3n) .tip { left: auto; right: 0; }
    .stat-card:hover .tip,
    .metric-card:hover .tip,
    .metric-hero:hover .tip { opacity: 1; visibility: visible; }

    /* ── Tables ── */
    .table-panel { background: var(--surface-low); border-radius: 0.75rem; overflow: hidden; margin-bottom: 0.6rem; }
    .table-header { padding: 0.875rem 1.25rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); }
    .table-title { font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: var(--muted); }
    .table-badge { font-size: 0.55rem; background: var(--surface-hi); color: var(--muted); padding: 0.15rem 0.45rem; border-radius: 0.25rem; font-family: monospace; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 0.5rem 1.25rem; font-size: 0.55rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 0.55rem 1.25rem; border-bottom: 1px solid rgba(72,72,71,0.05); font-size: 0.78rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(38,38,38,0.3); }
    code { font-family: 'SF Mono','Fira Code',monospace; font-size: 0.68rem; color: var(--muted); }
    a { color: inherit; text-decoration: none; }
    /* Make table links clearly clickable */
    .table-panel td a code {
      color: rgba(173,170,170,0.9);
      text-decoration: underline;
      text-decoration-color: rgba(173,170,170,0.3);
      text-underline-offset: 2px;
    }
    .table-panel td a:hover code { color: var(--primary); text-decoration-color: rgba(0,255,163,0.5); }
    .num { font-family: 'SF Mono','Fira Code',monospace; font-size: 0.73rem; }
    .badge-yes    { color: var(--primary); font-family: monospace; font-weight: 700; font-size: 0.68rem; letter-spacing: 0.05em; }
    .badge-no     { color: var(--tertiary); font-family: monospace; font-weight: 700; font-size: 0.68rem; letter-spacing: 0.05em; }
    .badge-option { color: #818cf8; font-family: 'Inter', sans-serif; font-weight: 700; font-size: 0.72rem; }
    .outcome-entity { color: #818cf8; font-weight: 700; }
    .pos { color: var(--primary); }
    .neg { color: var(--tertiary); }
    .empty { text-align: center; padding: 1.5rem; color: var(--muted); font-style: italic; }

    /* ── Status Bar ── */
    .statusbar {
      position: fixed; bottom: 0; left: var(--sidebar); right: 0;
      height: var(--statusbar); background: #000;
      border-top: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 1rem; font-size: 0.55rem; font-family: monospace;
      color: rgba(173,170,170,0.4); z-index: 100;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    .status-dot {
      display: inline-block; width: 5px; height: 5px; border-radius: 50%;
      background: var(--primary); box-shadow: 0 0 5px rgba(0,255,163,0.5);
      margin-right: 0.4rem; vertical-align: middle;
    }

    /* ── Column sort & filter ── */
    th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    th.sortable:hover { color: var(--text); }
    .th-inner { display: flex; align-items: center; gap: 0.25rem; }
    .sort-icon { font-size: 0.55rem; opacity: 0.3; flex-shrink: 0; }
    th.sort-asc  .sort-icon, th.sort-desc .sort-icon { opacity: 1; color: #818cf8; }
    .th-filter-btn {
      background: none; border: none; cursor: pointer; padding: 0 0.1rem;
      color: var(--muted); opacity: 0.3; line-height: 1; flex-shrink: 0;
      transition: opacity 0.1s, color 0.1s; display: inline-flex; align-items: center;
    }
    .th-filter-btn:hover { opacity: 0.8; }
    .th-filter-btn.active { opacity: 1; color: #818cf8; }
    /* ── Filter popover ── */
    .filter-popover {
      position: fixed; z-index: 1000;
      background: #1a1919; border: 1px solid rgba(99,102,241,0.3);
      border-radius: 0.45rem; padding: 0.55rem 0.65rem 0.45rem;
      box-shadow: 0 8px 24px rgba(0,0,0,0.55); min-width: 150px;
      display: none;
    }
    .filter-popover.open { display: block; }
    .fp-label { font-size: 0.5rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 0.35rem; opacity: 0.6; }
    .fp-input {
      width: 100%; background: transparent; border: none;
      border-bottom: 1px solid rgba(72,72,71,0.4);
      color: var(--text); font-size: 0.68rem; font-family: 'Inter', sans-serif;
      padding: 0.2rem 0; outline: none;
    }
    .fp-input::placeholder { color: var(--muted); opacity: 0.45; }
    .fp-input:focus { border-bottom-color: #6366f1; }
    select.fp-input { cursor: pointer; color: var(--muted); }
    select.fp-input:focus { color: var(--text); }
    .fp-options { display: flex; flex-direction: column; gap: 1px; margin-top: 0.1rem; }
    .fp-option {
      padding: 0.28rem 0.45rem; border-radius: 0.3rem; cursor: pointer;
      font-size: 0.68rem; color: var(--muted); transition: background 0.1s, color 0.1s;
      white-space: nowrap;
    }
    .fp-option:hover { background: rgba(99,102,241,0.1); color: var(--text); }
    .fp-option.fp-sel { color: #818cf8; background: rgba(99,102,241,0.12); font-weight: 600; }
    .fp-clear {
      margin-top: 0.4rem; width: 100%; background: none; border: none;
      cursor: pointer; color: var(--muted); font-size: 0.55rem; text-align: right;
      font-family: 'Inter', sans-serif; opacity: 0.4; padding: 0; letter-spacing: 0.03em;
    }
    .fp-clear:hover { opacity: 1; color: var(--tertiary); }

    /* ── Time range buttons ── */
    .time-filter { display: flex; gap: 0.3rem; }
    .time-btn {
      background: var(--surface-hi); border: 1px solid var(--border);
      color: var(--muted); border-radius: 0.3rem; padding: 0.2rem 0.55rem;
      font-size: 0.58rem; font-family: monospace; cursor: pointer;
      letter-spacing: 0.05em; transition: all 0.15s;
    }
    .time-btn:hover { color: var(--text); border-color: rgba(99,102,241,0.4); }
    .time-btn.active { background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.5); color: #818cf8; }

    /* ── Trade log badges ── */
    .tl-badge {
      display: inline-block; font-size: 0.55rem; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase;
      padding: 0.15rem 0.45rem; border-radius: 0.25rem; font-family: monospace;
    }
    .tl-copy     { background: rgba(99,102,241,0.15); color: #818cf8; }
    .tl-5m       { background: rgba(245,158,11,0.15); color: #f59e0b; }
    .tl-open     { background: rgba(245,158,11,0.12); color: #f59e0b; }
    .tl-closed   { background: rgba(173,170,170,0.1); color: var(--muted); }
    .tl-resolved { background: rgba(0,255,163,0.1);   color: var(--primary); }

    /* ── Allocation donut ── */
    .alloc-row { display: grid; grid-template-columns: 210px 1fr; gap: 2rem; align-items: center; margin-bottom: 0.75rem; }
    .alloc-chart-wrap { width: 200px; height: 200px; flex-shrink: 0; }
    .alloc-portfolio-hd { margin-bottom: 0.85rem; }
    .alloc-portfolio-label { font-size: 0.44rem; text-transform: uppercase; letter-spacing: 0.15em; color: var(--muted); margin-bottom: 0.2rem; }
    .alloc-portfolio-value { font-family: 'Space Grotesk', sans-serif; font-size: 1.4rem; font-weight: 700; line-height: 1; }
    .alloc-legend { display: flex; flex-direction: column; gap: 0.7rem; }
    .alloc-item { display: flex; flex-direction: column; gap: 0.28rem; }
    .alloc-item-hd { display: flex; align-items: center; gap: 0.55rem; }
    .alloc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .alloc-item-label { font-size: 0.58rem; color: var(--muted); flex: 1; text-transform: uppercase; letter-spacing: 0.08em; }
    .alloc-item-value { font-family: 'Space Grotesk', sans-serif; font-size: 0.88rem; font-weight: 700; }
    .alloc-item-pct { font-size: 0.55rem; color: var(--muted); font-family: monospace; margin-left: 0.35rem; }
    .alloc-bar-track { height: 2px; background: rgba(72,72,71,0.25); border-radius: 999px; overflow: hidden; }
    .alloc-bar-fill { height: 100%; border-radius: 999px; }
    /* ── Asset logo cell ── */
    .asset-cell { display: flex; align-items: center; gap: 0.4rem; }
    .asset-logo { width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0; }

    @media (max-width: 900px) {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .statusbar { left: 0; }
      .metrics-hd { grid-template-columns: 1fr 1fr; }
      .charts-row { grid-template-columns: 1fr; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>

<nav class="topnav">
  <span class="topnav-brand">Polymarket Copybot</span>
  <span class="topnav-right">Actualizado ${d.now} &nbsp;·&nbsp; paper trading</span>
</nav>

<aside class="sidebar">
  <div class="sidebar-brand-area">
    <div class="sidebar-brand">KV Terminal</div>
    <div class="sidebar-ver">v1.0.0 · paper mode</div>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-item active" data-tab="tab-dashboard">
      <span class="ms">grid_view</span> Dashboard
    </div>
    <div class="nav-item" data-tab="tab-copy">
      <span class="ms">query_stats</span> Copy Trading
    </div>
    <div class="nav-item" data-tab="tab-btc5m">
      <span class="ms">bolt</span> Early-Bird 5m
    </div>
    <div class="nav-item" data-tab="tab-historial">
      <span class="ms">receipt_long</span> Historial
    </div>
    <div class="nav-item" data-tab="tab-arb">
      <span class="ms">balance</span> Arbitraje
    </div>
  </nav>
  <div class="sidebar-footer">
    <div class="sf-card">
      <div class="sf-label">System Status</div>
      <div class="prog-bar"><div class="prog-fill"></div></div>
      <div class="sf-meta"><span>Latency</span><span>OK</span></div>
    </div>
  </div>
</aside>

<main class="main">

  <!-- ══ TAB: Dashboard ══ -->
  <div class="tab-pane active" id="tab-dashboard">

    <div class="metrics-hd">
      <div class="metric-hero">
        <div class="hero-icon-clip">
          <span class="ms hero-icon">account_balance_wallet</span>
        </div>
        <div class="hero-label">Valor del portfolio (USDC)</div>
        <div class="hero-value">${money(d.portfolio)}</div>
        <span class="hero-badge ${d.pnlTotal < 0 ? 'neg-badge' : ''}">${pnlPct} vs capital inicial</span>
      </div>

      <div class="metric-card" style="border-left: 2px solid rgba(99,102,241,0.25)">
        <div class="mc-label">Cash libre</div>
        <div>
          <div class="mc-value">${money(d.bankroll)}</div>
          <div class="mc-sub">${utilPct}% del portfolio desplegado</div>
        </div>
        <div class="tip">USDC sin invertir disponible para nuevas posiciones.<br><br>Disminuye al abrir posiciones y se recupera al cerrarlas. La diferencia con el Portfolio total es el capital actualmente en posiciones abiertas.</div>
      </div>

      <div class="metric-card" style="${pnlLeftAccent}">
        <div class="mc-label">P&amp;L realizado</div>
        <div>
          <div class="mc-value ${cls(d.pnlTotal)}">${money(d.pnlTotal, true)}</div>
          <div class="mc-sub">Capital inicial: ${money(CONFIG.PAPER_BANKROLL)}</div>
        </div>
        <div class="tip">Ganancia o pérdida neta de operaciones cerradas, descontando comisiones (slippage + fee).<br><br>= Portfolio actual − Capital inicial ($${CONFIG.PAPER_BANKROLL})<br><br>No incluye ganancias/pérdidas no realizadas de posiciones abiertas.</div>
      </div>

      <div class="metric-card" style="${winLeftAccent}">
        <div class="mc-label">Win rate global</div>
        <div>
          <div class="mc-value ${winCls(d.winRate)}">${pct(d.winRate)}</div>
          <div class="mc-sub">${d.openPositions + d.btc5mOpen} posiciones abiertas</div>
        </div>
        <div class="tip">Porcentaje de operaciones cerradas que terminaron con ganancia.<br><br>Incluye todas las estrategias: copy trading y Early-Bird 5m combinadas.<br><br>Verde ≥ 50% · Rojo &lt; 50%</div>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem">
      <div class="time-filter">
        <button class="time-btn" data-days="7">7D</button>
        <button class="time-btn" data-days="30">30D</button>
        <button class="time-btn" data-days="90">3M</button>
        <button class="time-btn active" data-days="0">Todo</button>
      </div>
    </div>
    <div class="charts-row">
      <div class="chart-panel">
        <div class="cp-hd">
          <div class="cp-title">Bankroll Equity</div>
          <div class="cp-sub">Evolución del cash libre — baja al abrir posiciones, sube al cerrarlas</div>
        </div>
        <div class="chart-wrap"><canvas id="bankrollChart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="cp-hd">
          <div class="cp-title">P&amp;L Diario</div>
          <div class="cp-sub">Cambio en cash libre por día — aproximado (no incluye variación de posiciones)</div>
        </div>
        <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
      </div>
    </div>

    <div class="sec-div" style="--accent:#6366f1">
      <div class="sec-dot"></div>
      <div class="sec-label">Resumen global</div>
      <div class="sec-line"></div>
    </div>
    <div class="stats-grid" style="--accent:#6366f1">
      ${statCard('Capital total desplegado', money(d.globalInvested), '', 'Suma acumulada de todo el capital invertido desde el inicio en ambas estrategias.<br><br>Incluye capital reciclado de trades cerrados. No es el capital inicial — es el volumen total operado.')}
      ${statCard('Capital cerrado',          money(d.globalClosed),   '', 'Capital que pertenecía a posiciones ya cerradas en ambas estrategias.<br><br>Este capital volvió al bankroll al cerrar las posiciones (con ganancia o pérdida).')}
      ${statCard('Capital activo ahora',     money(d.globalOpen),     '', 'Capital actualmente desplegado en posiciones abiertas de copy trading y 5m.<br><br>= Portfolio total − Cash libre')}
    </div>

  </div><!-- /tab-dashboard -->

  <!-- ══ TAB: Copy Trading ══ -->
  <div class="tab-pane" id="tab-copy">

    <div class="sec-div" style="--accent:#6366f1; margin-top:0">
      <div class="sec-dot"></div>
      <div class="sec-label">Copy Trading</div>
      <div class="sec-line"></div>
    </div>
    <div class="stats-grid" style="--accent:#6366f1">
      ${statCard('Win rate',
          pct(cs.closed_count > 0 ? cs.wins / cs.closed_count : null),
          cls(cs.closed_count > 0 ? cs.wins / cs.closed_count - 0.5 : null),
          'Porcentaje de operaciones de copy trading cerradas con ganancia.<br><br>Verde ≥ 50% · Rojo &lt; 50% · — si no hay operaciones cerradas.',
          winBcls(cs.closed_count > 0 ? cs.wins / cs.closed_count : null))}
      ${statCard('Operaciones cerradas',
          cs.closed_count ?? 0,
          '',
          'Número total de trades de copy trading ya cerrados (ganados + perdidos).<br><br>Las posiciones abiertas actualmente no se cuentan aquí.')}
      ${statCard('P&amp;L realizado',
          money(cs.pnl_total ?? 0, true),
          cls(cs.pnl_total),
          'Suma de ganancias y pérdidas de todos los trades de copy cerrados, descontando comisiones.<br><br>No incluye resultados de posiciones todavía abiertas.',
          bcls(cs.pnl_total))}
      ${statCard('Capital total (acum.)',
          money(cs.total_invested),
          '',
          'Capital total invertido en copy trading desde el inicio.<br><br>Incluye capital reciclado: si un trade se cierra y ese dinero se reinvierte, cuenta dos veces. Mide el volumen operado, no el capital inicial.')}
      ${statCard('Capital cerrado',
          money(cs.total_closed),
          '',
          'Capital que estaba en posiciones de copy trading ya cerradas.<br><br>Este capital se ha recuperado al bankroll (con ganancia o pérdida incluida en P&L).')}
      ${statCard('Capital activo',
          money(cs.total_open),
          '',
          'Capital actualmente desplegado en posiciones abiertas de copy trading.<br><br>Este importe está "en el mercado" y se recuperará al cerrar las posiciones.')}
    </div>
    ${positionsTable(d.positions)}
    ${walletsTable(d.wallets)}

  </div><!-- /tab-copy -->

  <!-- ══ TAB: Early-Bird 5m ══ -->
  <div class="tab-pane" id="tab-btc5m">

    <div class="sec-div" style="--accent:#6366f1; margin-top:0">
      <div class="sec-dot"></div>
      <div class="sec-label">Early-Bird 5m</div>
      <div class="sec-line"></div>
    </div>
    <div class="stats-grid" style="--accent:#6366f1">
      ${statCard('Win rate',
          pct(bs.closed > 0 ? bs.wins / bs.closed : null),
          cls(bs.closed > 0 ? bs.wins / bs.closed - 0.5 : null),
          'Porcentaje de operaciones 5m cerradas con ganancia.<br><br>Verde ≥ 50% · Rojo &lt; 50% · — si no hay operaciones cerradas.',
          winBcls(bs.closed > 0 ? bs.wins / bs.closed : null))}
      ${statCard('Operaciones cerradas',
          bs.closed ?? 0,
          '',
          'Número total de trades de la estrategia Early-Bird 5m ya cerrados.<br><br>Entra en el mercado en los primeros 3 minutos de vida del contrato BTC.')}
      ${statCard('P&amp;L realizado',
          money(bs.total_pnl ?? 0, true),
          cls(bs.total_pnl),
          'Suma de ganancias y pérdidas de todos los trades 5m cerrados, descontando comisiones.<br><br>No incluye posiciones todavía abiertas.',
          bcls(bs.total_pnl))}
      ${statCard('Capital total (acum.)',
          money(bs.total_invested),
          '',
          'Capital total invertido en la estrategia 5m desde el inicio.<br><br>Incluye capital reciclado entre operaciones consecutivas.')}
      ${statCard('Capital cerrado',
          money(bs.total_closed),
          '',
          'Capital de posiciones 5m ya cerradas, recuperado al bankroll.')}
      ${statCard('Capital activo',
          money(bs.total_open),
          '',
          'Capital actualmente en posiciones abiertas de la estrategia 5m.')}
    </div>
    ${btc5mTable(d.btc5mPositions)}

  </div><!-- /tab-btc5m -->

  <!-- ══ TAB: Historial ══ -->
  <div class="tab-pane" id="tab-historial">

    <div class="sec-div" style="--accent:#6366f1; margin-top:0">
      <div class="sec-dot"></div>
      <div class="sec-label">Flujo de capital</div>
      <div class="sec-line"></div>
    </div>

${(() => {
      const p = d.portfolio || 1;
      const cashPct  = (d.bankroll / p * 100);
      const copyPct  = ((d.copyStats.total_open ?? 0) / p * 100);
      const btc5Pct  = ((d.btc5mStats.total_open ?? 0) / p * 100);
      const allocItem = (color, label, value, valueCls, pct, barColor) => `
        <div class="alloc-item">
          <div class="alloc-item-hd">
            <div class="alloc-dot" style="background:${color}"></div>
            <div class="alloc-item-label">${label}</div>
            <div class="alloc-item-value ${valueCls}">${value}</div>
            <div class="alloc-item-pct">${pct.toFixed(0)}%</div>
          </div>
          <div class="alloc-bar-track">
            <div class="alloc-bar-fill" style="width:${pct.toFixed(1)}%;background:${barColor}"></div>
          </div>
        </div>`;
      return `
    <div class="alloc-row">
      <div class="alloc-chart-wrap">
        <canvas id="allocChart"></canvas>
      </div>
      <div class="alloc-legend">
        <div class="alloc-portfolio-hd">
          <div class="alloc-portfolio-label">Portfolio total</div>
          <div class="alloc-portfolio-value">${money(d.portfolio)}</div>
        </div>
        ${allocItem('#00FFA3', 'Cash libre',          money(d.bankroll),                  'pos',         cashPct, '#00FFA3')}
        ${allocItem('#818cf8', 'Copy Trading activo', money(d.copyStats.total_open),      '',            copyPct, '#818cf8')}
        ${allocItem('#f59e0b', 'Early-Bird 5m activo',money(d.btc5mStats.total_open),     '',            btc5Pct, '#f59e0b')}
        <div class="alloc-item" style="margin-top:0.2rem;padding-top:0.6rem;border-top:1px solid var(--border)">
          <div class="alloc-item-hd">
            <div class="alloc-dot" style="background:transparent;border:1px solid rgba(173,170,170,0.3)"></div>
            <div class="alloc-item-label">P&amp;L vs capital inicial</div>
            <div class="alloc-item-value ${cls(d.pnlTotal)}">${money(d.pnlTotal, true)}</div>
            <div class="alloc-item-pct ${cls(d.pnlTotal)}">${pnlPct}</div>
          </div>
        </div>
      </div>
    </div>`;
    })()}

    <div class="stats-grid" style="--accent:#6366f1">
      ${statCard('Capital total operado', money(d.hist.totalDeployed), '',
        'Suma de todas las inversiones realizadas (copy + 5m), incluyendo capital reciclado de operaciones cerradas.')}
      ${statCard('Comisiones + slippage', money(d.hist.totalCost), 'neg',
        'Total pagado en fees de protocolo y slippage en todas las operaciones.<br><br>Es el coste real de operar, deducido del resultado final.',
        'border-neg')}
      ${statCard('P&amp;L neto realizado', money(d.hist.totalPnl, true), cls(d.hist.totalPnl),
        'Resultado neto de todas las operaciones cerradas o resueltas.<br><br>Positivo = el bot ha generado beneficio. Negativo = pérdida neta hasta ahora.',
        bcls(d.hist.totalPnl))}
      ${statCard('Operaciones abiertas', d.hist.openOps, '',
        'Número de posiciones actualmente en el mercado (copy + 5m).<br><br>El capital está comprometido hasta que estas posiciones se resuelvan.')}
      ${statCard('Operaciones cerradas', d.hist.closedOps, '',
        'Total de operaciones que ya han concluido (cerradas o resueltas).<br><br>El capital fue recuperado al bankroll con ganancia o pérdida.')}
      ${statCard('Total operaciones', d.hist.totalOps, '',
        'Número total de operaciones realizadas desde el inicio (abiertas + cerradas).')}
    </div>

    ${tradeLogTable(d.tradeLog)}

  </div><!-- /tab-historial -->

  <!-- ══ TAB: Arbitraje ══ -->
  <div class="tab-pane" id="tab-arb">

    <div class="sec-div" style="--accent:#f59e0b; margin-top:0">
      <div class="sec-dot"></div>
      <div class="sec-label">Arbitraje</div>
      <div class="sec-line"></div>
    </div>

    <div class="stats-grid" style="--accent:#f59e0b">
      ${statCard('Oportunidades activas',
          d.arb.openOpportunities,
          '',
          'Número de discrepancias de precio detectadas actualmente en el mercado que cumplen los criterios mínimos de rentabilidad y confianza.')}
      ${statCard('Posiciones abiertas',
          d.arb.openLegs,
          '',
          'Pares/piernas de arbitraje actualmente desplegadas en papel. Cada oportunidad puede tener 2 o más piernas.')}
      ${statCard('P&amp;L realizado (arb)',
          money(d.arb.pnlRealized, true),
          cls(d.arb.pnlRealized),
          'Ganancia o pérdida neta de todas las operaciones de arbitraje ya cerradas.',
          bcls(d.arb.pnlRealized))}
      ${statCard('Beneficio medio esperado',
          d.arb.avgExpectedProfit != null ? pct(d.arb.avgExpectedProfit) : '—',
          d.arb.avgExpectedProfit > 0 ? 'pos' : '',
          'Media del beneficio esperado (tras comisiones) de todas las oportunidades abiertas detectadas.')}
      ${statCard('Operaciones cerradas',
          d.arb.closedLegs,
          '',
          'Total de piernas de arbitraje ya liquidadas (mercado resuelto o expirado).')}
      ${statCard('Win rate arb',
          pct(d.arb.winRate),
          winCls(d.arb.winRate),
          'Porcentaje de piernas de arbitraje cerradas con ganancia.',
          winBcls(d.arb.winRate))}
    </div>

    <div class="sec-div" style="--accent:#f59e0b">
      <div class="sec-dot"></div>
      <div class="sec-label">Oportunidades detectadas</div>
      <div class="sec-line"></div>
    </div>

    ${arbOpportunitiesTable(d.arb.opportunities)}

    <div class="sec-div" style="--accent:#f59e0b">
      <div class="sec-dot"></div>
      <div class="sec-label">Posiciones abiertas</div>
      <div class="sec-line"></div>
    </div>

    ${arbTradesTable(d.arb.activeTrades)}

    <div class="sec-div" style="--accent:#f59e0b">
      <div class="sec-dot"></div>
      <div class="sec-label">Historial de operaciones</div>
      <div class="sec-line"></div>
    </div>

    ${arbHistoryTable(d.arb.closedTrades)}

  </div><!-- /tab-arb -->

</main>

<footer class="statusbar">
  <div style="display:flex;gap:1.5rem;align-items:center">
    <span><span class="status-dot"></span>Polymarket API: Online</span>
    <span>Paper mode activo</span>
  </div>
  <div style="display:flex;gap:1.5rem">
    <span>Copy: ${d.openPositions} pos</span>
    <span style="color:rgba(0,255,163,0.5)">5m: ${d.btc5mOpen} pos</span>
    <span style="color:rgba(245,158,11,0.7)">Arb: ${d.arb.openLegs} piernas</span>
  </div>
</footer>

<script>
  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.tab;
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      item.classList.add('active');
      document.getElementById(target).classList.add('active');
    });
  });

  // ── Charts ────────────────────────────────────────────────────────────────
  const SNAPS = ${snapsJSON};

  Chart.defaults.color = '#ADAAAA';
  Chart.defaults.font.family = 'Inter';
  Chart.defaults.font.size = 10;

  const baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: 'index', intersect: false,
        backgroundColor: '#1a1919',
        titleColor: '#ADAAAA', bodyColor: '#ffffff',
        borderColor: 'rgba(72,72,71,0.3)', borderWidth: 1, padding: 10,
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#ADAAAA', maxTicksLimit: 8 }, border: { display: false } },
      y: { grid: { color: 'rgba(72,72,71,0.15)' }, ticks: { color: '#ADAAAA' }, border: { display: false } },
    },
  };

  // ── Allocation donut ──────────────────────────────────────────────────────
  new Chart(document.getElementById('allocChart'), {
    type: 'doughnut',
    data: {
      labels: ['Cash libre', 'Copy activo', '5m activo'],
      datasets: [{
        data: [${d.bankroll.toFixed(2)}, ${(d.copyStats.total_open ?? 0).toFixed(2)}, ${(d.btc5mStats.total_open ?? 0).toFixed(2)}],
        backgroundColor: ['rgba(0,255,163,0.8)', 'rgba(129,140,248,0.8)', 'rgba(245,158,11,0.8)'],
        borderColor:     ['#00FFA3', '#818cf8', '#f59e0b'],
        borderWidth: 1.5,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '68%',
      layout: { padding: 8 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1919',
          titleColor: '#ADAAAA', bodyColor: '#ffffff',
          borderColor: 'rgba(72,72,71,0.3)', borderWidth: 1, padding: 10,
          callbacks: { label: ctx => ' $' + ctx.parsed.toFixed(2) },
        },
      },
    },
  });

  // ── Chart temporality ────────────────────────────────────────────────────
  let bankrollChart = null, pnlChart = null;

  function renderCharts(days) {
    const now    = Date.now();
    const cutoff = days > 0 ? now - days * 86400000 : 0;
    const data   = SNAPS.filter(s => cutoff === 0 || new Date(s.date).getTime() >= cutoff);
    const labels = data.map(s => s.date);

    if (bankrollChart) { bankrollChart.destroy(); bankrollChart = null; }
    if (pnlChart)      { pnlChart.destroy();      pnlChart      = null; }
    if (!data.length)  return;

    bankrollChart = new Chart(document.getElementById('bankrollChart'), {
      type: 'line',
      data: { labels, datasets: [{
        data: data.map(s => s.bankroll),
        borderColor: '#00FFA3', backgroundColor: 'rgba(0,255,163,0.06)',
        fill: true, tension: 0.4,
        pointRadius: data.length > 20 ? 0 : 3, pointHoverRadius: 5,
        borderWidth: 2, pointBackgroundColor: '#00FFA3',
      }]},
      options: { ...baseOpts },
    });

    pnlChart = new Chart(document.getElementById('pnlChart'), {
      type: 'bar',
      data: { labels, datasets: [{
        data: data.map(s => s.pnlDay),
        backgroundColor: data.map(s => s.pnlDay >= 0 ? 'rgba(0,255,163,0.7)' : 'rgba(255,77,77,0.7)'),
        borderRadius: 2,
      }]},
      options: { ...baseOpts },
    });
  }

  document.querySelectorAll('.time-btn[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-btn[data-days]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCharts(parseInt(btn.dataset.days));
    });
  });

  renderCharts(0);

  // ── Filter popover (shared singleton) ───────────────────────────────────
  const fpEl = document.createElement('div');
  fpEl.className = 'filter-popover';
  document.body.appendChild(fpEl);
  let fpActiveBtn = null;

  function fpClose() {
    fpEl.classList.remove('open');
    fpActiveBtn = null;
  }

  document.addEventListener('click', e => {
    if (fpEl.contains(e.target)) return;
    if (e.target.closest('.th-filter-btn')) return;
    fpClose();
  }, true);

  function fpOpen(btn, tableFilters, applyFn) {
    if (fpActiveBtn === btn) { fpClose(); return; }
    fpClose();
    fpActiveBtn = btn;

    const col  = parseInt(btn.dataset.filterCol);
    const type = btn.dataset.filterType;
    const ph   = btn.dataset.filterPh || 'Filtrar…';
    const opts = btn.dataset.filterOpts || '';
    const cur  = tableFilters[col] || '';
    const label = btn.closest('th').querySelector('span:first-child').textContent;

    let inputHtml;
    if (type === 'select') {
      const optItems = opts.split('|').map(o => {
        const parts = o.split(':'), l = parts[0], v = parts[1] !== undefined ? parts[1] : '';
        const sel = cur === v ? ' fp-sel' : '';
        return '<div class="fp-option' + sel + '" data-val="' + v + '">' + l + '</div>';
      }).join('');
      inputHtml = '<div class="fp-options">' + optItems + '</div>';
    } else {
      inputHtml = '<input class="fp-input" data-col="' + col + '" placeholder="' + ph + '" value="' + cur.replace(/"/g, '&quot;') + '">';
    }

    fpEl.innerHTML = '<div class="fp-label">' + label + '</div>' + inputHtml + '<button class="fp-clear">Limpiar</button>';

    const rect = btn.getBoundingClientRect();
    const pW = 170;
    let left = rect.left;
    if (left + pW > window.innerWidth - 8) left = window.innerWidth - pW - 8;
    fpEl.style.top  = (rect.bottom + 4) + 'px';
    fpEl.style.left = Math.max(4, left) + 'px';
    fpEl.classList.add('open');

    if (type === 'select') {
      fpEl.querySelectorAll('.fp-option').forEach(opt => {
        opt.addEventListener('click', () => {
          const val = opt.dataset.val;
          tableFilters[col] = val;
          fpEl.querySelectorAll('.fp-option').forEach(o => o.classList.toggle('fp-sel', o === opt && val !== ''));
          btn.classList.toggle('active', !!val);
          applyFn();
          fpClose();
        });
      });
    } else {
      const inputEl = fpEl.querySelector('.fp-input');
      inputEl.focus();
      inputEl.select?.();
      inputEl.addEventListener('input', () => {
        tableFilters[col] = inputEl.value.trim().toLowerCase();
        btn.classList.toggle('active', !!tableFilters[col]);
        applyFn();
      });
    }

    fpEl.querySelector('.fp-clear').addEventListener('click', () => {
      tableFilters[col] = '';
      btn.classList.remove('active');
      applyFn();
      fpClose();
    });
  }

  // ── Column sort + filter ─────────────────────────────────────────────────
  function initSortableTable(tbodyId, badgeId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const thead    = tbody.closest('table').querySelector('thead');
    const sortThs  = [...thead.querySelectorAll('th.sortable')];
    const filterBtns = [...thead.querySelectorAll('.th-filter-btn')];
    const tableFilters = {};

    let sortCol = -1, sortDir = 0;

    function apply() {
      const allRows = [...tbody.querySelectorAll('tr')];
      if (sortDir !== 0 && sortCol >= 0) {
        allRows.sort((a, b) => {
          const ca = a.cells[sortCol]?.textContent.trim() ?? '';
          const cb = b.cells[sortCol]?.textContent.trim() ?? '';
          const na = parseFloat(ca.replace(/[^0-9.-]/g, ''));
          const nb = parseFloat(cb.replace(/[^0-9.-]/g, ''));
          const cmp = (!isNaN(na) && !isNaN(nb)) ? na - nb : ca.localeCompare(cb, 'es');
          return sortDir === 1 ? cmp : -cmp;
        });
        allRows.forEach(r => tbody.appendChild(r));
      }
      let visible = 0;
      [...tbody.querySelectorAll('tr')].forEach(row => {
        const show = Object.entries(tableFilters).every(([col, val]) => {
          if (!val) return true;
          const cell = row.cells[parseInt(col)];
          if (!cell) return true;
          return cell.textContent.trim().toLowerCase().includes(val);
        });
        row.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      const badge = document.getElementById(badgeId);
      if (badge) badge.textContent = badge.textContent.replace(/^\d+/, visible);
    }

    sortThs.forEach(th => {
      th.addEventListener('click', e => {
        if (e.target.closest('.th-filter-btn')) return;
        const col = parseInt(th.dataset.col);
        sortDir = sortCol === col ? (sortDir === 1 ? -1 : sortDir === -1 ? 0 : 1) : 1;
        sortCol = sortDir === 0 ? -1 : col;
        sortThs.forEach(h => {
          h.classList.remove('sort-asc', 'sort-desc');
          const icon = h.querySelector('.sort-icon');
          if (icon) icon.textContent = '⇅';
        });
        if (sortDir === 1)  { th.classList.add('sort-asc');  th.querySelector('.sort-icon').textContent = '↑'; }
        if (sortDir === -1) { th.classList.add('sort-desc'); th.querySelector('.sort-icon').textContent = '↓'; }
        apply();
      });
    });

    filterBtns.forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        fpOpen(btn, tableFilters, apply);
      });
    });
  }

  initSortableTable('tbl-pos',       'badge-pos');
  initSortableTable('tbl-wallets',   'badge-wallets');
  initSortableTable('tbl-btc5m',     'badge-btc5m');
  initSortableTable('tbl-tradelog',  'badge-tradelog');
  initSortableTable('tbl-arb-opps',  'badge-arb-opps');
  initSortableTable('tbl-arb-trades','badge-arb-trades');
  initSortableTable('tbl-arb-hist',  'badge-arb-hist');
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

  const snapshots  = all(db, `SELECT date, bankroll, pnl_day FROM snapshots ORDER BY date ASC`);
  const positions  = all(db, `SELECT p.*, w.name AS wallet_name FROM positions p LEFT JOIN wallets w ON p.wallet = w.address ORDER BY p.opened_at DESC`);
  const wallets    = all(db, `SELECT * FROM wallets WHERE active = 1 ORDER BY score DESC`);
  const btc5mPos   = all(db, `SELECT * FROM btc5m_positions ORDER BY opened_at DESC`);

  const btc5mStats = all(db, `
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
      SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END)      AS wins,
      SUM(COALESCE(pnl, 0))                                                 AS pnl_total
    FROM trades
  `)[0] ?? { total_invested: 0, total_closed: 0, total_open: 0, closed_count: 0, wins: 0, pnl_total: 0 };

  const latest   = snapshots[snapshots.length - 1];
  const prev     = snapshots[snapshots.length - 2];
  const bankroll = latest?.bankroll ?? CONFIG.PAPER_BANKROLL;

  const globalOpen = (copyStats.total_open ?? 0) + (btc5mStats.total_open ?? 0);
  const portfolio  = bankroll + globalOpen;
  const pnlTotal   = portfolio - CONFIG.PAPER_BANKROLL;
  const pnlDay     = prev ? bankroll - prev.bankroll : (latest?.pnl_day ?? 0);

  // Combined trade log (copy + 5m), most recent first
  const tradeLog = all(db, `
    SELECT
      'copy'             AS strategy,
      t.executed_at      AS opened_at,
      t.market_id,
      t.outcome,
      t.size_usdc,
      t.fee + t.slippage AS cost,
      t.status,
      t.pnl,
      p.slug                            AS slug,
      COALESCE(t.title, p.title)        AS title,
      COALESCE(t.market_slug, p.market_slug) AS market_slug,
      NULL                              AS asset
    FROM trades t
    LEFT JOIN (SELECT DISTINCT market_id, slug, title, market_slug FROM positions WHERE slug IS NOT NULL OR title IS NOT NULL) p
           ON t.market_id = p.market_id
    UNION ALL
    SELECT
      '5m'               AS strategy,
      bt.opened_at,
      bt.market_id,
      bt.outcome,
      bt.size_usdc,
      bt.fee + bt.slippage AS cost,
      bt.status,
      bt.pnl,
      bt.slug,
      NULL               AS title,
      NULL               AS market_slug,
      bt.asset
    FROM btc5m_trades bt
    ORDER BY opened_at DESC
  `);

  const histRow = all(db, `
    SELECT
      SUM(size_usdc)                                                       AS total_deployed,
      SUM(fee + slippage)                                                  AS total_cost,
      SUM(CASE WHEN status != 'open' THEN COALESCE(pnl,0) ELSE 0 END)    AS total_pnl,
      COUNT(*)                                                             AS total_ops,
      SUM(CASE WHEN status  = 'open' THEN 1 ELSE 0 END)                  AS open_ops,
      SUM(CASE WHEN status != 'open' THEN 1 ELSE 0 END)                  AS closed_ops
    FROM (
      SELECT size_usdc, fee, slippage, status, pnl FROM trades
      UNION ALL
      SELECT size_usdc, fee, slippage, status, pnl FROM btc5m_trades
    )
  `)[0] ?? {};

  const winRateRow = all(db, `
    SELECT (SUM(w) * 1.0 / SUM(t)) as win_rate
    FROM (
      SELECT SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as w, COUNT(*) as t
        FROM trades WHERE status = 'closed' AND pnl IS NOT NULL
      UNION ALL
      SELECT SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), COUNT(*)
        FROM btc5m_trades WHERE status != 'open'
    )
  `)[0];

  // ── Arbitrage data ──────────────────────────────────────────────────────────
  const arbOpps = all(db,
    `SELECT ao.*, ag.strategy as grp_strategy
     FROM arb_opportunities ao
     LEFT JOIN arb_groups ag ON ao.group_id = ag.id
     ORDER BY ao.detected_at DESC
     LIMIT 200`
  );

  const arbActiveTrades = all(db,
    `SELECT at.*, ao.strategy
     FROM arb_trades at
     JOIN arb_opportunities ao ON at.opportunity_id = ao.id
     WHERE at.status = 'open'
     ORDER BY at.opened_at DESC`
  );

  const arbClosedTrades = all(db,
    `SELECT at.*, ao.strategy
     FROM arb_trades at
     JOIN arb_opportunities ao ON at.opportunity_id = ao.id
     WHERE at.status = 'closed'
     ORDER BY at.closed_at DESC
     LIMIT 200`
  );

  const arbStats = all(db,
    `SELECT
       SUM(CASE WHEN status = 'open'   THEN 1 ELSE 0 END) as open_legs,
       SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_legs,
       SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
       SUM(COALESCE(pnl, 0)) as pnl_realized
     FROM arb_trades`
  )[0] ?? { open_legs: 0, closed_legs: 0, wins: 0, pnl_realized: 0 };

  const arbOpenOpps = all(db,
    `SELECT COUNT(*) as n, AVG(expected_profit) as avg_profit
     FROM arb_opportunities WHERE status = 'open'`
  )[0] ?? { n: 0, avg_profit: null };

  const data = {
    now, bankroll, pnlTotal, pnlDay, portfolio, globalOpen,
    winRate:        winRateRow?.win_rate ?? null,
    openPositions:  positions.length,
    btc5mOpen:      btc5mPos.length,
    snapshots:      snapshots.map(s => ({ date: s.date, bankroll: s.bankroll, pnlDay: s.pnl_day })),
    positions, wallets,
    btc5mPositions: btc5mPos,
    btc5mStats, copyStats,
    globalInvested: (copyStats.total_invested ?? 0) + (btc5mStats.total_invested ?? 0),
    globalClosed:   (copyStats.total_closed   ?? 0) + (btc5mStats.total_closed   ?? 0),
    tradeLog,
    hist: {
      totalDeployed: histRow.total_deployed ?? 0,
      totalCost:     histRow.total_cost     ?? 0,
      totalPnl:      histRow.total_pnl      ?? 0,
      totalOps:      histRow.total_ops      ?? 0,
      openOps:       histRow.open_ops       ?? 0,
      closedOps:     histRow.closed_ops     ?? 0,
    },
    arb: {
      opportunities:       arbOpps,
      activeTrades:        arbActiveTrades,
      closedTrades:        arbClosedTrades,
      openOpportunities:   arbOpenOpps.n ?? 0,
      openLegs:            arbStats.open_legs   ?? 0,
      closedLegs:          arbStats.closed_legs ?? 0,
      pnlRealized:         arbStats.pnl_realized ?? 0,
      avgExpectedProfit:   arbOpenOpps.avg_profit ?? null,
      winRate:             arbStats.closed_legs > 0 ? (arbStats.wins / arbStats.closed_legs) : null,
    },
  };

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/index.html', render(data));
  console.log(`Dashboard → docs/index.html [${new Date().toISOString()}]`);
}

main().catch(err => {
  console.error('dashboard:fatal', err.message);
  process.exit(1);
});

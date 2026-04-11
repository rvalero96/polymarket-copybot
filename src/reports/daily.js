import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

async function main() {
  const db   = await getDb();
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);

  const latestSnap    = all(db, `SELECT * FROM snapshots ORDER BY date DESC LIMIT 2`);
  const todaySnap     = latestSnap[0];
  const prevSnap      = latestSnap[1];
  const openPositions = all(db, `SELECT * FROM positions ORDER BY opened_at DESC`);
  const todayTrades   = all(db,
    `SELECT * FROM trades WHERE date(executed_at/1000, 'unixepoch') = ? ORDER BY executed_at DESC`,
    [date]
  );
  const allTrades     = all(db, `SELECT * FROM trades WHERE status = 'closed'`);
  const wallets       = all(db, `SELECT * FROM wallets WHERE active = 1 ORDER BY score DESC`);

  const bankroll  = todaySnap?.bankroll ?? CONFIG.PAPER_BANKROLL;
  const pnlTotal  = bankroll - CONFIG.PAPER_BANKROLL;
  const pnlDay    = prevSnap ? bankroll - prevSnap.bankroll : 0;
  const pnlPct    = (pnlTotal / CONFIG.PAPER_BANKROLL * 100).toFixed(2);
  const winRatePct = allTrades.length > 0
    ? ((todaySnap?.win_rate ?? 0) * 100).toFixed(1)
    : 'n/a';

  run(db,
    `INSERT OR REPLACE INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [date, bankroll, pnlDay, pnlTotal, openPositions.length, parseFloat(winRatePct) / 100 || 0, Date.now()]
  );
  db.persist();

  const sign = n => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);

  const md = `# Daily report — ${date}

## Summary
| Metric | Value |
|---|---|
| Bankroll | **${bankroll.toFixed(2)} USDC** |
| P&L today | ${sign(pnlDay)} USDC |
| P&L total | ${sign(pnlTotal)} USDC (${pnlPct}%) |
| Open positions | ${openPositions.length} |
| Win rate | ${winRatePct}% |
| Trades today | ${todayTrades.length} |

## Open positions
${openPositions.length === 0 ? '_No open positions_' : openPositions.map(p =>
  `- **${p.market_id}** · ${p.outcome} · avg ${p.avg_price.toFixed(3)} · ${p.size_usdc.toFixed(2)} USDC · from \`${p.wallet.slice(0,8)}…\``
).join('\n')}

## Trades today
${todayTrades.length === 0 ? '_No trades today_' : todayTrades.map(t =>
  `- ${t.side === 'buy' ? 'BUY' : 'SELL'} **${t.market_id}** · ${t.outcome} · ${t.size_usdc.toFixed(2)} USDC @ ${t.price.toFixed(3)}`
).join('\n')}

## Active roster (${wallets.length} wallets)
${wallets.map((w, i) =>
  `${i + 1}. \`${w.address.slice(0, 10)}…\` · score ${w.score?.toFixed(3) ?? 'n/a'} · win rate ${((w.win_rate ?? 0) * 100).toFixed(1)}% · ROI ${((w.roi ?? 0) * 100).toFixed(1)}%`
).join('\n')}

---
_Generated at ${now.toISOString()} · mode: ${CONFIG.TRADING_MODE}_
`;

  if (!existsSync('reports')) mkdirSync('reports');
  const path = `reports/${date}.md`;
  writeFileSync(path, md);
  logger.info('report:written', { path });
  console.log(md);
}

main().catch(err => {
  logger.error('report:fatal', { error: err.message });
  process.exit(1);
});

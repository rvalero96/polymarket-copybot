import fetch from 'node-fetch';
import { CONFIG } from '../../../config.js';
import { logger } from '../../utils/logger.js';

const { GAMMA_BASE, CLOB_BASE, DATA_API } = CONFIG.API;

async function get(url, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const full = qs ? `${url}?${qs}` : url;
  logger.debug('api:get', { url: full });
  const res = await fetch(full, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`API ${res.status} — ${full}`);
  return res.json();
}

export async function getWalletPositions(address) {
  return get(`${DATA_API}/positions`, { user: address, sizeThreshold: '0.01' });
}

export async function getWalletTrades(address, limit = 500) {
  return get(`${DATA_API}/activity`, { user: address, limit });
}

export async function getWalletPnL(address) {
  return get(`${DATA_API}/portfolio-performance`, { address });
}

export async function getMarket(conditionId) {
  const data = await get(`${GAMMA_BASE}/markets`, { condition_id: conditionId });
  return data?.[0] ?? null;
}

export async function getActiveMarkets({ limit = 100, offset = 0 } = {}) {
  return get(`${GAMMA_BASE}/markets`, { active: 'true', closed: 'false', limit, offset });
}

export async function getMidpointPrice(tokenId) {
  const data = await get(`${CLOB_BASE}/midpoint`, { token_id: tokenId });
  return parseFloat(data?.mid ?? 0);
}

export async function get5mMarkets(baseSlug) {
  // 5m markets follow the pattern: {baseSlug}-{unix_window_start}
  // where unix_window_start is the nearest 5-min boundary (divisible by 300).
  // We try the current window + the next 2 upcoming windows.
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(nowSec / 300) * 300;
  const windows = [currentWindow, currentWindow + 300, currentWindow + 600];

  const markets = [];
  for (const ts of windows) {
    const slug = `${baseSlug}-${ts}`;
    try {
      const data = await get(`${GAMMA_BASE}/markets`, { slug });
      const list = Array.isArray(data) ? data : (data?.data ?? []);
      markets.push(...list);
    } catch (_) { /* window may not exist yet */ }
  }
  return markets;
}

export async function getLeaderboard({ limit = 50, offset = 0 } = {}) {
  // Endpoint correcto del leaderboard de Polymarket
  return get(`${GAMMA_BASE}/leaderboard`, { limit, offset });
}

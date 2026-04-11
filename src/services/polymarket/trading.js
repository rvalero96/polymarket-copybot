import { logger } from '../../utils/logger.js';

export async function openPosition({ marketId, outcome, sizeUsdc, price }) {
  logger.warn('live:openPosition — Phase 2 not implemented', { marketId, outcome, sizeUsdc, price });
  throw new Error('Phase 2 not implemented yet');
}

export async function closePosition({ marketId, outcome, size, price }) {
  logger.warn('live:closePosition — Phase 2 not implemented', { marketId, outcome, size, price });
  throw new Error('Phase 2 not implemented yet');
}

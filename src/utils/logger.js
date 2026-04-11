const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(lvl, msg, meta = {}) {
  if (LEVELS[lvl] < LEVELS[level]) return;
  const line = {
    ts: new Date().toISOString(),
    level: lvl,
    msg,
    ...meta,
  };
  console.log(JSON.stringify(line));
}

export const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};

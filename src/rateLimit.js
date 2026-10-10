// Small in-memory fixed-window rate limiter (per process). Good enough to protect the
// ingest and login endpoints; a multi-instance deployment would move this to a shared store.
const { tooManyRequests } = require('./errors');

function rateLimit({ windowMs, max, keyFn, message }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    const resetSeconds = Math.ceil((h.resetAt - now) / 1000);
    res.set({
      'RateLimit-Limit': String(max),
      'RateLimit-Remaining': String(Math.max(0, max - h.count)),
      'RateLimit-Reset': String(resetSeconds),
    });
    if (h.count > max) {
      res.set('Retry-After', String(resetSeconds));
      return next(tooManyRequests(message));
    }
    return next();
  };
}

module.exports = { rateLimit };

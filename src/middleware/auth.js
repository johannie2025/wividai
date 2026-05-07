// ─── auth.js ─────────────────────────────────────────────────────────────────
export function authMiddleware(req, res, next) {
  const secret   = process.env.INTERNAL_SECRET;
  const provided = req.headers['x-internal-secret'];
  if (!secret || provided !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ─── logger.js ───────────────────────────────────────────────────────────────
export function logger(req, res, next) {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - t0;
    const type = req.body?.type ?? '-';
    console.log(`[${new Date().toISOString().slice(11,19)}] ${req.method} ${req.path} (${type}) → ${res.statusCode} ${ms}ms`);
  });
  next();
}

// ─── error.js ────────────────────────────────────────────────────────────────
export function errorHandler(err, req, res, _next) {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'internal_error', message: err.message });
}

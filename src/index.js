/**
 * WiVidAi Node Service — Unified Hyperframes Engine
 * ──────────────────────────────────────────────────
 * Routes exposées :
 *   GET  /health
 *   POST /generate          { type: 'image'|'video', ... }   ← endpoint unifié
 *   POST /jobs/image        { gen_id, prompt, ... }          ← appelé par PHP NodeService
 *   POST /jobs/video        { gen_id, prompt, ... }          ← appelé par PHP NodeService
 *   GET  /outputs/*         fichiers statiques locaux
 */
import 'dotenv/config';
import express           from 'express';
import { createServer }  from 'http';
import path              from 'path';
import { fileURLToPath } from 'url';

import { authMiddleware, logger, errorHandler } from './middleware/auth.js';
import { handleGenerate }                       from './handlers/generate.js';
import imageRouter                              from '../routes/image.js';
import videoRouter                              from '../routes/video.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(logger);

// ─── Static outputs (local storage mode) ─────────────────────────────────────
app.use('/outputs', express.static(
  path.join(__dirname, '../public/outputs'),
  { maxAge: '30d', etag: true }
));
app.use('/videos', express.static(
  path.join(__dirname, '../public/videos'),
  { maxAge: '7d', etag: true }
));

// ─── Health (public) ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:      true,
    service: 'wividai-node',
    engine:  'hyperframes',
    uptime:  Math.floor(process.uptime()),
    mem_mb:  Math.round(process.memoryUsage().rss / 1024 / 1024),
    time:    new Date().toISOString(),
  });
});

// ─── Unified generate endpoint (auth required) ────────────────────────────────
// POST /generate  { type: 'image'|'video', ... }
app.post('/generate', authMiddleware, handleGenerate);

// ─── Legacy job routes — PHP NodeService appelle ces endpoints ────────────────
// POST /jobs/image  { gen_id, prompt, style, width, height, model, webhook, secret }
// POST /jobs/video  { gen_id, prompt, style, width, height, duration, model, webhook, secret }
app.use('/jobs/image', authMiddleware, imageRouter);
app.use('/jobs/video', authMiddleware, videoRouter);

// ─── 404 / Error ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  WiVidAi Node  ·  Hyperframes Engine         ║`);
  console.log(`║  Port : ${PORT}   ·  Routes: /generate /jobs/*  ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
});

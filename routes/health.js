import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'wividai-node',
    version: process.env.npm_package_version || '1.0.0',
    uptime:  Math.floor(process.uptime()),
    memory:  process.memoryUsage().rss,
    time:    new Date().toISOString(),
  });
});

export default router;

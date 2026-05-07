/**
 * POST /jobs/video
 *
 * Hyperframes pipeline:
 *   1. OpenRouter chat model → animated HTML
 *   2. Puppeteer renders HTML → PNG frames
 *   3. FFmpeg encodes frames → MP4
 *   4. Upload MP4 → public URL
 *   5. Webhook → PHP with output_url
 */

import { Router }                        from 'express';
import { generateHyperframeHTML }        from '../src/services/openrouter.js';
import { renderHyperframe, cleanupMp4 } from '../src/services/hyperframes.js';
import { uploadVideo }                   from '../src/services/upload.js';
import { callWebhook }                   from '../src/services/webhook.js';
import { validateJob }                   from '../src/middleware/validate.js';

const router = Router();

router.post('/', validateJob, async (req, res) => {
  const {
    gen_id,
    prompt,
    style    = '',
    width    = 512,
    height   = 512,
    duration = 4,
    format   = '1:1',
    quality  = 'sd',
    model,
    webhook,
    secret,
  } = req.body;

  // 202 immediately — pipeline runs async
  res.status(202).json({ queued: true, gen_id, pipeline: 'hyperframes' });

  (async () => {
    let mp4Path = null;
    try {
      console.log(`[HF #${gen_id}] Generating HTML via ${model}…`);
      const html = await generateHyperframeHTML({ model, prompt, style, width, height, duration, format });

      console.log(`[HF #${gen_id}] Rendering ${width}x${height} @ ${duration}s…`);
      mp4Path = await renderHyperframe({ html, width, height, duration, quality });

      console.log(`[HF #${gen_id}] Uploading…`);
      const outputUrl = await uploadVideo(mp4Path, gen_id);

      await callWebhook(webhook, secret, {
        gen_id,
        status:     'completed',
        output_url: outputUrl,
        meta: { width, height, duration, format, quality, pipeline: 'hyperframes' },
      });
      console.log(`[HF #${gen_id}] Done → ${outputUrl}`);

    } catch (err) {
      console.error(`[HF #${gen_id}] FAILED:`, err.message);
      await callWebhook(webhook, secret, { gen_id, status: 'failed', error: err.message }).catch(() => {});
    } finally {
      if (mp4Path) cleanupMp4(mp4Path);
    }
  })();
});

export default router;

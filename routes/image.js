import { Router } from 'express';
import { generateHyperframeHTML } from '../src/services/openrouter.js';
import { uploadImage }            from '../src/services/upload.js';
import { callWebhook }            from '../src/services/webhook.js';
import { validateJob }            from '../src/middleware/validate.js';

const router = Router();

/**
 * POST /jobs/image
 * Body: { gen_id, prompt, style, width, height, model, webhook, secret }
 * Response: 202 immédiat, puis webhook quand terminé.
 */
router.post('/', validateJob, async (req, res) => {
  const { gen_id, prompt, style = '', width = 512, height = 512, model, webhook, secret } = req.body;

  res.status(202).json({ queued: true, gen_id });

  (async () => {
    try {
      const html      = await generateHyperframeHTML({ model, prompt, style, width, height, duration: 1, format: '1:1', type: 'image' });
      const outputUrl = await uploadImage(html, gen_id, width, height);

      await callWebhook(webhook, secret, {
        gen_id,
        status:     'completed',
        output_url: outputUrl,
        meta:       { width, height, model, pipeline: 'hyperframes' },
      });

    } catch (err) {
      console.error(`[Image job ${gen_id}] failed:`, err.message);
      await callWebhook(webhook, secret, {
        gen_id,
        status: 'failed',
        error:  err.message,
      }).catch(() => {});
    }
  })();
});

export default router;

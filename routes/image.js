import { Router } from 'express';
import { generateImage } from '../services/openrouter.js';
import { callWebhook }   from '../services/webhook.js';
import { validateJob }   from '../middleware/validate.js';

const router = Router();

/**
 * POST /jobs/image
 * Body: { gen_id, prompt, style, width, height, model, webhook, secret }
 * Response: 202 immediately, then calls webhook when done.
 */
router.post('/', validateJob, async (req, res) => {
  const { gen_id, prompt, style, width, height, model, webhook, secret } = req.body;

  // Acknowledge immediately — PHP is waiting for 202, not for the image
  res.status(202).json({ queued: true, gen_id });

  // ─── Async generation (no await on route level) ─────────────────────────
  (async () => {
    try {
      const fullPrompt = style ? `${prompt}. Style: ${style}` : prompt;

      const result = await generateImage({
        model,
        prompt: fullPrompt,
        width,
        height,
        // Optimised for speed on free tier
        num_inference_steps: width > 768 ? 4 : 3,  // FLUX schnell is fast at 3-4 steps
        guidance_scale: 0,
        seed: Math.floor(Math.random() * 2 ** 32),
      });

      await callWebhook(webhook, secret, {
        gen_id,
        status:     'completed',
        output_url: result.url,
        meta:       { width, height, model },
      });

    } catch (err) {
      console.error(`[Image job ${gen_id}] failed:`, err.message);
      await callWebhook(webhook, secret, {
        gen_id,
        status: 'failed',
        error:  err.message,
      }).catch(() => {}); // swallow webhook failure
    }
  })();
});

export default router;

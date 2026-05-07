/**
 * handlers/generate.js
 * Endpoint unifié POST /generate
 * Dispatche vers le pipeline image ou vidéo selon req.body.type
 */
import { generateHyperframeHTML } from '../services/openrouter.js';
import { renderHyperframe, cleanupMp4 } from '../services/hyperframes.js';
import { uploadVideo }            from '../services/upload.js';
import { uploadImage }            from '../services/upload.js';
import { callWebhook }            from '../services/webhook.js';

export async function handleGenerate(req, res) {
  const { type } = req.body;

  if (!type || !['image', 'video'].includes(type)) {
    return res.status(400).json({ error: 'type must be "image" or "video"' });
  }

  // Déléguer au handler approprié
  if (type === 'image') return handleImage(req, res);
  if (type === 'video') return handleVideo(req, res);
}

// ─── Image ────────────────────────────────────────────────────────────────────
async function handleImage(req, res) {
  const {
    gen_id, prompt, style = '', width = 512, height = 512,
    model, webhook, secret,
  } = req.body;

  res.status(202).json({ queued: true, gen_id, pipeline: 'hyperframes-image' });

  (async () => {
    try {
      const html      = await generateHyperframeHTML({ model, prompt, style, width, height, duration: 1, format: '1:1', type: 'image' });
      const outputUrl = await uploadImage(html, gen_id, width, height);

      await callWebhook(webhook, secret, {
        gen_id, status: 'completed', output_url: outputUrl,
        meta: { width, height, model, pipeline: 'hyperframes' },
      });
    } catch (err) {
      console.error(`[Image #${gen_id}] FAILED:`, err.message);
      await callWebhook(webhook, secret, { gen_id, status: 'failed', error: err.message }).catch(() => {});
    }
  })();
}

// ─── Video ────────────────────────────────────────────────────────────────────
async function handleVideo(req, res) {
  const {
    gen_id, prompt, style = '', width = 512, height = 512,
    duration = 4, format = '1:1', quality = 'sd',
    model, webhook, secret,
  } = req.body;

  res.status(202).json({ queued: true, gen_id, pipeline: 'hyperframes-video' });

  (async () => {
    let mp4Path = null;
    try {
      const html = await generateHyperframeHTML({ model, prompt, style, width, height, duration, format, type: 'video' });
      mp4Path    = await renderHyperframe({ html, width, height, duration, quality });
      const outputUrl = await uploadVideo(mp4Path, gen_id);

      await callWebhook(webhook, secret, {
        gen_id, status: 'completed', output_url: outputUrl,
        meta: { width, height, duration, format, quality, pipeline: 'hyperframes' },
      });
    } catch (err) {
      console.error(`[Video #${gen_id}] FAILED:`, err.message);
      await callWebhook(webhook, secret, { gen_id, status: 'failed', error: err.message }).catch(() => {});
    } finally {
      if (mp4Path) cleanupMp4(mp4Path);
    }
  })();
}

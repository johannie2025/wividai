/**
 * middleware/validate.js
 * Validation minimale des payloads job avant traitement.
 */
export function validateJob(req, res, next) {
  const { gen_id, prompt, webhook } = req.body;

  if (!gen_id || !Number.isInteger(Number(gen_id)) || Number(gen_id) <= 0) {
    return res.status(400).json({ error: 'gen_id requis (entier positif)' });
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt requis (min 3 caractères)' });
  }
  if (!webhook || !webhook.startsWith('http')) {
    return res.status(400).json({ error: 'webhook URL requise' });
  }

  req.body.gen_id = Number(req.body.gen_id);
  next();
}

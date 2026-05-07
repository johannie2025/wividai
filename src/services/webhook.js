// src/services/webhook.js
import crypto from 'crypto';

/**
 * Call the PHP webhook with HMAC signature.
 * Retries once on network failure.
 */
export async function callWebhook(url, secret, payload, retries = 1) {
  const body = JSON.stringify(payload);
  const sig  = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-WiVidAi-Sig':   sig,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[Webhook] ${res.status} on attempt ${attempt + 1}`);
        if (attempt < retries) continue;
      }

      return await res.json().catch(() => ({}));

    } catch (err) {
      console.error(`[Webhook] attempt ${attempt + 1} failed:`, err.message);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
    }
  }
}

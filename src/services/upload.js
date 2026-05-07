/**
 * upload.js — Gestion du stockage des fichiers générés
 *
 * Stratégies (par priorité) :
 *   1. S3 / Cloudflare R2   → URL publique permanente (prod recommandé)
 *   2. Local Express static  → URL via /videos/* (dev / self-hosted)
 *   3. Base64 inline         → encodé dans le webhook payload (fallback Render free)
 *
 * STOCKAGE EN BASE DE DONNÉES :
 *   Le fichier MP4/JPG est envoyé en base64 dans le webhook payload.
 *   PHP le reçoit via WebhookController → StorageService → sauvegarde en BLOB
 *   ou en fichier local, puis stocke l'URL dans `generations.output_url`.
 *
 *   Cela évite toute dépendance à un filesystem persistant sur Render.com free tier.
 */

import fs      from 'fs';
import path    from 'path';
import crypto  from 'crypto';
import puppeteer from 'puppeteer';

const STORAGE_MODE = process.env.STORAGE_MODE || 'db';  // db | local | s3
const PUBLIC_URL   = process.env.PUBLIC_URL   || process.env.APP_URL || 'http://localhost:3001';
const LOCAL_VIDEOS = path.resolve('./public/videos');
const LOCAL_IMAGES = path.resolve('./public/outputs');
const TMP_DIR      = process.env.TMP_DIR || '/tmp/wividai';

[LOCAL_VIDEOS, LOCAL_IMAGES, TMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── VIDEO ────────────────────────────────────────────────────────────────────

/**
 * Upload MP4 et retourne son URL publique.
 * En mode 'db', encode en base64 pour transmission dans le webhook.
 */
export async function uploadVideo(mp4Path, genId) {
  if (STORAGE_MODE === 's3')  return uploadToS3(mp4Path, genId, 'video/mp4', 'mp4');
  if (STORAGE_MODE === 'db')  return encodeBase64ForDb(mp4Path, 'video/mp4');

  // mode local
  const filename = `gen_${genId}_${Date.now()}.mp4`;
  const dest     = path.join(LOCAL_VIDEOS, filename);
  fs.copyFileSync(mp4Path, dest);
  return `${PUBLIC_URL}/videos/${filename}`;
}

// ─── IMAGE ────────────────────────────────────────────────────────────────────

/**
 * Capture screenshot du HTML généré → retourne URL ou base64.
 */
export async function uploadImage(html, genId, width, height) {
  const id       = crypto.randomUUID();
  const htmlPath = path.join(TMP_DIR, `${id}.html`);
  const jpgPath  = path.join(TMP_DIR, `${id}.jpg`);

  fs.writeFileSync(htmlPath, html, 'utf8');

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--single-process', `--window-size=${width},${height}`,
      ],
      defaultViewport: { width, height, deviceScaleFactor: 1 },
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 15_000 });
    await new Promise(r => setTimeout(r, 300)); // settle animations

    await page.screenshot({
      path: jpgPath, type: 'jpeg', quality: 90,
      clip: { x: 0, y: 0, width, height },
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(htmlPath, { force: true });
  }

  try {
    if (STORAGE_MODE === 's3') return uploadToS3(jpgPath, genId, 'image/jpeg', 'jpg');
    if (STORAGE_MODE === 'db') return encodeBase64ForDb(jpgPath, 'image/jpeg');

    // local
    const filename = `gen_${genId}_${Date.now()}.jpg`;
    const dest     = path.join(LOCAL_IMAGES, filename);
    fs.copyFileSync(jpgPath, dest);
    return `${PUBLIC_URL}/outputs/${filename}`;
  } finally {
    fs.rmSync(jpgPath, { force: true });
  }
}

// ─── Base64 pour stockage DB ──────────────────────────────────────────────────

/**
 * Encode le fichier en base64 data URI.
 * PHP reçoit cette chaîne dans output_url du webhook,
 * la détecte et la stocke en BLOB ou fichier local.
 *
 * Format : data:<mime>;base64,<data>
 * PHP détecte ce format via str_starts_with($url, 'data:')
 */
function encodeBase64ForDb(filePath, mimeType) {
  const data   = fs.readFileSync(filePath);
  const b64    = data.toString('base64');
  const dataUri = `data:${mimeType};base64,${b64}`;
  console.log(`[Upload] DB mode — ${Math.round(data.length / 1024)}KB encodé en base64`);
  return dataUri; // retourné comme output_url dans le webhook
}

// ─── S3 / R2 ─────────────────────────────────────────────────────────────────

async function uploadToS3(filePath, genId, contentType, ext) {
  const {
    S3_ENDPOINT, S3_BUCKET, S3_REGION = 'auto',
    S3_ACCESS_KEY, S3_SECRET_KEY,
  } = process.env;

  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    throw new Error('S3 env vars non configurés. Définissez STORAGE_MODE=local ou db');
  }

  const filename = `generations/${genId}_${Date.now()}.${ext}`;
  const fileData = fs.readFileSync(filePath);
  const url      = `${S3_ENDPOINT}/${S3_BUCKET}/${filename}`;

  const date        = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateShort   = date.slice(0, 8);
  const contentHash = crypto.createHash('sha256').update(fileData).digest('hex');

  const canonicalHeaders = `content-type:${contentType}\nhost:${new URL(S3_ENDPOINT).host}\nx-amz-content-sha256:${contentHash}\nx-amz-date:${date}\n`;
  const signedHeaders    = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', `/${S3_BUCKET}/${filename}`, '', canonicalHeaders, signedHeaders, contentHash].join('\n');
  const credScope        = `${dateShort}/${S3_REGION}/s3/aws4_request`;
  const strToSign        = `AWS4-HMAC-SHA256\n${date}\n${credScope}\n` + crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const signingKey       = hmac(hmac(hmac(hmac(`AWS4${S3_SECRET_KEY}`, dateShort), S3_REGION), 's3'), 'aws4_request');
  const signature        = crypto.createHmac('sha256', signingKey).update(strToSign).digest('hex');
  const authHeader       = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credScope},SignedHeaders=${signedHeaders},Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'X-Amz-Date': date, 'X-Amz-Content-Sha256': contentHash, 'Authorization': authHeader },
    body: fileData,
  });

  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${await res.text()}`);
  return `${process.env.S3_PUBLIC_URL || S3_ENDPOINT}/${S3_BUCKET}/${filename}`;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

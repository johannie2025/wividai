/**
 * hyperframes.js — HTML → MP4 renderer
 *
 * Pipeline:
 *   1. Write AI-generated HTML to a temp file
 *   2. Open in Puppeteer (headless Chrome) with exact viewport
 *   3. Capture frames at target FPS using Page.screencast or screenshot loop
 *   4. Pipe PNG frames into FFmpeg → MP4 (H.264, web-compatible)
 *   5. Return final MP4 file path
 *
 * Optimised for Render.com free tier (512MB RAM, shared CPU):
 *   - SD: 15fps, CRF 28  (~fast)
 *   - HD: 24fps, CRF 23  (~slower, higher quality)
 */

import puppeteer    from 'puppeteer';
import ffmpeg       from 'fluent-ffmpeg';
import ffmpegPath   from '@ffmpeg-installer/ffmpeg';
import fs           from 'fs';
import path         from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import crypto       from 'crypto';

ffmpeg.setFfmpegPath(ffmpegPath.path);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = process.env.TMP_DIR || '/tmp/wividai';

// Ensure tmp dir exists
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * Render HTML animation to MP4.
 *
 * @param {object} opts
 * @param {string} opts.html      - Full HTML content
 * @param {number} opts.width     - Viewport width (px)
 * @param {number} opts.height    - Viewport height (px)
 * @param {number} opts.duration  - Video duration in seconds
 * @param {string} opts.quality   - 'sd' | 'hd'
 * @returns {Promise<string>}     - Path to MP4 file
 */
export async function renderHyperframe({ html, width, height, duration, quality = 'sd' }) {
  const id      = crypto.randomUUID();
  const htmlPath = path.join(TMP_DIR, `${id}.html`);
  const framesDir = path.join(TMP_DIR, `frames_${id}`);
  const mp4Path   = path.join(TMP_DIR, `${id}.mp4`);

  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');

  const fps      = quality === 'hd' ? 24 : 15;
  const totalFrames = duration * fps;
  const frameDuration = 1000 / fps; // ms per frame

  let browser = null;

  try {
    // ─── 1. Launch headless Chrome ─────────────────────────────────
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',    // critical for Docker/Render
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',           // reduces memory on free tier
        '--disable-extensions',
        `--window-size=${width},${height}`,
      ],
      defaultViewport: { width, height, deviceScaleFactor: 1 },
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Load HTML as file:// so inline scripts execute
    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'networkidle0',
      timeout: 15_000,
    });

    // Give animations time to initialise (CSS transitions, canvas setup)
    await sleep(200);

    // ─── 2. Capture frames ─────────────────────────────────────────
    // We control time by injecting a fake clock override.
    // This lets us step through the animation deterministically.
    await page.evaluate((totalDuration) => {
      // Override requestAnimationFrame to be clock-driven
      window.__wividai_frame = 0;
      window.__wividai_duration = totalDuration * 1000;
    }, duration);

    for (let i = 0; i < totalFrames; i++) {
      // Advance animation clock
      const timeMs = (i / totalFrames) * duration * 1000;
      await page.evaluate((t) => {
        // Tick CSS animations
        if (document.timeline) {
          try { document.timeline.currentTime = t; } catch(e) {}
        }
        window.__wividai_time = t;
      }, timeMs);

      // Small settle time for JS animations
      await sleep(Math.max(1, frameDuration - 20));

      const framePath = path.join(framesDir, `frame_${String(i).padStart(5, '0')}.png`);
      await page.screenshot({
        path: framePath,
        type: 'png',
        clip: { x: 0, y: 0, width, height },
      });
    }

    // ─── 3. Encode to MP4 with FFmpeg ──────────────────────────────
    await encodeFramesToMp4({
      framesDir,
      mp4Path,
      fps,
      width,
      height,
      quality,
    });

    return mp4Path;

  } finally {
    if (browser) await browser.close().catch(() => {});
    // Cleanup HTML + frames (keep mp4, caller handles cleanup)
    fs.rmSync(htmlPath, { force: true });
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

/**
 * FFmpeg: PNG frame sequence → MP4 (H.264, yuv420p, web-compatible)
 */
function encodeFramesToMp4({ framesDir, mp4Path, fps, width, height, quality }) {
  return new Promise((resolve, reject) => {
    const crf = quality === 'hd' ? 23 : 28;

    ffmpeg()
      .input(path.join(framesDir, 'frame_%05d.png'))
      .inputFPS(fps)
      .videoCodec('libx264')
      .outputOptions([
        `-crf ${crf}`,
        '-preset fast',         // good balance speed/size on free tier
        '-pix_fmt yuv420p',     // browser compatibility
        `-vf scale=${width}:${height}`,
        '-movflags +faststart', // web streaming optimisation
        '-an',                  // no audio
        '-r', String(fps),
      ])
      .output(mp4Path)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * Clean up MP4 file after it has been uploaded/served.
 */
export function cleanupMp4(mp4Path) {
  fs.rmSync(mp4Path, { force: true });
}

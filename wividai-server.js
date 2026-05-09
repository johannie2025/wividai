/**
 * WIVIDAI CINEMATIC ENGINE — Node.js Server
 * Deploy on Render.com (Free Tier)
 * Stack: Fastify + Puppeteer + Canvas + FFmpeg + AI (Gemini/OpenRouter)
 *
 * Features:
 *  - WVML JSON generation via Gemini Flash 1.5 / OpenRouter fallback
 *  - HTML5 Canvas cinematic rendering (server-side via Puppeteer)
 *  - MP4 export via ffmpeg
 *  - Hollywood FX: parallax, camera dolly, lower thirds, lens flare,
 *    chromatic aberration, film grain, depth-of-field blur, glitch,
 *    logo animation, particle systems, light rays
 *  - Styles: Marvel, Dune, Black Panther, Avengers, Neon Noir
 */

const Fastify = require('fastify');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('@fastify/cors');
const multipart = require('@fastify/multipart');

// ── Chrome path resolver (Render.com + local dev) ──
function getChromePath() {
  // Render.com installe chromium via apt (render.yaml)
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    if (p) {
      try { require('fs').accessSync(p); return p; } catch {}
    }
  }
  throw new Error('Chrome/Chromium introuvable. Vérifiez render.yaml (apt: chromium)');
}

const app = Fastify({ logger: true });
const PORT = process.env.PORT || 3000;
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const FRAMES_DIR = path.join(__dirname, 'frames');

if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });

app.register(cors, { origin: '*' });
app.register(multipart);
app.register(require('@fastify/static'), { root: OUTPUTS_DIR, prefix: '/videos/' });

// ═══════════════════════════════════════════════════════════════
// ██  AI BRAIN — WVML JSON GENERATOR
// ═══════════════════════════════════════════════════════════════

async function generateWVML(prompt, geminiKey, openrouterKey, style = 'cinematic') {
  const systemPrompt = `Tu es WIVIDAI, un architecte de vidéos cinématiques. 
Génère un WVML JSON COMPLET et CRÉATIF pour une vidéo MP4 de 15 secondes à 30fps en 9:16 (1080x1920).
Le WVML doit inclure des scènes SPECTACULAIRES avec:
- Mouvements de caméra (dolly, parallax, tilt, shake, orbit)
- Effets Hollywood (lens_flare, chromatic_aberration, film_grain, light_rays, depth_blur)
- Lower thirds professionnels avec animations
- Particules et systèmes de particules
- Animations de texte (glitch, typewriter, split_reveal, morph)
- Style visuel: ${style}
Réponds UNIQUEMENT avec le JSON valide, aucun texte avant/après.

Structure WVML obligatoire:
{
  "project": { "duration": 15, "fps": 30, "width": 1080, "height": 1920, "style": "...", "colorGrade": {...} },
  "audio": { "bgm": "...", "bpm": 128 },
  "camera": { "globalShake": 0.2, "depthOfField": true },
  "timeline": [
    {
      "id": "scene1", "start": 0, "end": 5,
      "background": { "type": "gradient|image|particle_field", ... },
      "camera": { "type": "dolly_in|parallax|orbit|tilt|handheld", "intensity": 0.8, "path": [...] },
      "layers": [
        { "type": "svg_bg|particle_system|text|logo|lower_third|light_ray|lens_flare|shape", ... }
      ],
      "fx": ["film_grain", "chromatic_aberration", "vignette", "lens_flare"]
    }
  ]
}`;

  // Try Gemini first
  if (geminiKey) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(systemPrompt + '\n\nPrompt utilisateur: ' + prompt);
      const text = result.response.text();
      const json = extractJSON(text);
      if (json) return { wvml: json, provider: 'gemini-1.5-flash' };
    } catch (e) {
      app.log.warn('Gemini failed, trying OpenRouter...', e.message);
    }
  }

  // Fallback: OpenRouter free models
  if (openrouterKey) {
    const freeModels = [
      'deepseek/deepseek-chat-v3-0324:free',
      'qwen/qwen3-8b:free',
      'mistralai/mistral-7b-instruct:free',
      'meta-llama/llama-3.1-8b-instruct:free'
    ];
    for (const model of freeModels) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://wividai.render.com',
            'X-Title': 'WIVIDAI'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt }
            ],
            temperature: 0.9,
            max_tokens: 4000
          })
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) {
          const json = extractJSON(text);
          if (json) return { wvml: json, provider: model };
        }
      } catch (e) {
        app.log.warn(`OpenRouter model ${model} failed:`, e.message);
      }
    }
  }

  // Final fallback: demo WVML
  return { wvml: getDemoWVML(prompt, style), provider: 'demo-fallback' };
}

function extractJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {}
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ██  CINEMATIC RENDERER HTML — injecté dans Puppeteer
// ═══════════════════════════════════════════════════════════════

function buildRendererHTML(wvml) {
  const wvmlStr = JSON.stringify(wvml);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#000; overflow:hidden; }
#canvas { display:block; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<script>
const WVML = ${wvmlStr};
const W = WVML.project.width || 1080;
const H = WVML.project.height || 1920;
const FPS = WVML.project.fps || 30;
const DURATION = WVML.project.duration || 15;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;

let currentFrame = 0;
let totalFrames = DURATION * FPS;
let particles = [];
let time = 0;

// ── Color Grading Presets ──
const GRADES = {
  marvel: { r:1.1, g:0.95, b:0.9, sat:1.3, bright:0.05, vignette:0.4 },
  dune: { r:1.15, g:1.05, b:0.7, sat:0.85, bright:0.02, vignette:0.5 },
  blackpanther: { r:0.85, g:0.9, b:1.2, sat:1.2, bright:-0.02, vignette:0.45 },
  avengers: { r:1.0, g:0.95, b:0.85, sat:1.1, bright:0.03, vignette:0.35 },
  neon_noir: { r:0.7, g:0.9, b:1.3, sat:1.5, bright:-0.05, vignette:0.6 },
  cinematic: { r:1.0, g:0.98, b:0.92, sat:1.15, bright:0.0, vignette:0.4 },
  pixar: { r:1.05, g:1.0, b:0.95, sat:1.25, bright:0.08, vignette:0.2 }
};

const style = WVML.project.style || 'cinematic';
const grade = GRADES[style] || GRADES.cinematic;

// ── Particle System ──
class Particle {
  constructor(x, y, opts = {}) {
    this.x = x; this.y = y;
    this.vx = (Math.random()-0.5) * (opts.speed || 2);
    this.vy = (Math.random()-0.5) * (opts.speed || 2) - (opts.rise || 0);
    this.life = 1.0;
    this.decay = 0.005 + Math.random() * 0.015;
    this.size = (opts.minSize || 1) + Math.random() * (opts.maxSize || 3);
    this.color = opts.color || 'rgba(255,200,100,0.8)';
    this.type = opts.type || 'circle';
    this.gravity = opts.gravity || 0;
    this.glow = opts.glow || false;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vy += this.gravity;
    this.life -= this.decay;
    this.size *= 0.995;
  }
  draw(ctx) {
    if (this.life <= 0) return;
    ctx.save();
    ctx.globalAlpha = this.life * 0.9;
    if (this.glow) {
      ctx.shadowBlur = this.size * 4;
      ctx.shadowColor = this.color;
    }
    ctx.fillStyle = this.color;
    if (this.type === 'star') {
      drawStar(ctx, this.x, this.y, this.size, this.size * 0.4, 5);
    } else if (this.type === 'spark') {
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x - this.vx * 5, this.y - this.vy * 5);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.size * 0.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawStar(ctx, x, y, r1, r2, pts) {
  ctx.beginPath();
  for (let i = 0; i < pts * 2; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = (i * Math.PI) / pts;
    i === 0 ? ctx.moveTo(x + r * Math.sin(a), y - r * Math.cos(a))
             : ctx.lineTo(x + r * Math.sin(a), y - r * Math.cos(a));
  }
  ctx.closePath();
  ctx.fill();
}

// ── Camera System ──
function applyCamera(scene, t) {
  const cam = scene.camera || {};
  const type = cam.type || 'static';
  const intensity = cam.intensity || 0.5;
  ctx.save();

  switch(type) {
    case 'dolly_in': {
      const scale = 1 + t * intensity * 0.3;
      ctx.translate(W/2, H/2);
      ctx.scale(scale, scale);
      ctx.translate(-W/2, -H/2);
      break;
    }
    case 'dolly_out': {
      const scale = 1 + (1-t) * intensity * 0.3;
      ctx.translate(W/2, H/2);
      ctx.scale(scale, scale);
      ctx.translate(-W/2, -H/2);
      break;
    }
    case 'parallax': {
      ctx.translate(Math.sin(t * Math.PI * 2) * W * 0.03 * intensity, 0);
      break;
    }
    case 'orbit': {
      const angle = t * Math.PI * 2 * intensity * 0.5;
      ctx.translate(W/2, H/2);
      ctx.rotate(angle * 0.02);
      ctx.translate(-W/2, -H/2);
      break;
    }
    case 'tilt': {
      ctx.translate(W/2, H/2);
      ctx.rotate(Math.sin(t * Math.PI) * 0.05 * intensity);
      ctx.translate(-W/2, -H/2);
      break;
    }
    case 'handheld': {
      const shakeX = (Math.sin(time * 13.7) * 0.5 + Math.sin(time * 7.3) * 0.5) * 8 * intensity;
      const shakeY = (Math.sin(time * 11.2) * 0.5 + Math.sin(time * 9.1) * 0.5) * 6 * intensity;
      ctx.translate(shakeX, shakeY);
      break;
    }
    case 'crane_up': {
      ctx.translate(0, -(t * H * 0.08 * intensity));
      break;
    }
    case 'crane_down': {
      ctx.translate(0, t * H * 0.08 * intensity);
      break;
    }
  }

  // Global shake
  if (WVML.camera && WVML.camera.globalShake) {
    const gs = WVML.camera.globalShake;
    ctx.translate(
      (Math.random() - 0.5) * gs * 4,
      (Math.random() - 0.5) * gs * 4
    );
  }
}

// ── Background Drawers ──
function drawBackground(bg, t) {
  if (!bg) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    return;
  }

  switch(bg.type) {
    case 'gradient': {
      const colors = bg.colors || ['#000', '#111'];
      const angle = (bg.angle || 180) * Math.PI / 180;
      const x1 = W/2 - Math.cos(angle) * W/2;
      const y1 = H/2 - Math.sin(angle) * H/2;
      const x2 = W/2 + Math.cos(angle) * W/2;
      const y2 = H/2 + Math.sin(angle) * H/2;
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      colors.forEach((c, i) => grad.addColorStop(i / (colors.length-1), c));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'radial_gradient': {
      const colors = bg.colors || ['#1a0a2e', '#000'];
      const grad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, H*0.7);
      colors.forEach((c, i) => grad.addColorStop(i / (colors.length-1), c));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'particle_field': {
      ctx.fillStyle = bg.baseColor || '#000010';
      ctx.fillRect(0, 0, W, H);
      // Animated nebula
      for (let i = 0; i < 5; i++) {
        const nx = W * (0.2 + i * 0.18) + Math.sin(t * 2 + i) * 50;
        const ny = H * (0.3 + Math.sin(i * 1.3) * 0.3) + Math.cos(t * 1.5 + i) * 30;
        const gr = ctx.createRadialGradient(nx, ny, 0, nx, ny, 200 + i * 80);
        gr.addColorStop(0, bg.nebulaColors?.[i] || 'rgba(100,50,200,0.15)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'city': {
      // Procedural city skyline
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#050510');
      sky.addColorStop(0.6, '#0a0520');
      sky.addColorStop(1, '#1a0510');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#0a0a15';
      for (let b = 0; b < 40; b++) {
        const bx = (b / 40) * W * 1.2 - W * 0.1 + Math.sin(b * 0.7 + t * 0.1) * 2;
        const bw = 15 + (b * 17) % 40;
        const bh = 100 + (b * 73) % 400;
        const by = H * 0.7 - bh;
        ctx.fillRect(bx, by, bw, bh);
        // Windows
        for (let wy = by + 10; wy < H * 0.7; wy += 15) {
          for (let wx = bx + 3; wx < bx + bw - 3; wx += 10) {
            if (Math.random() < 0.4 || (b * wy * wx) % 7 < 3) {
              ctx.fillStyle = Math.random() < 0.1 ? '#ff8800' : '#ffff88';
              ctx.globalAlpha = 0.5 + Math.sin(time * 3 + b + wy) * 0.3;
              ctx.fillRect(wx, wy, 5, 6);
              ctx.globalAlpha = 1;
              ctx.fillStyle = '#0a0a15';
            }
          }
        }
      }
      break;
    }
    default: {
      ctx.fillStyle = bg.color || '#000';
      ctx.fillRect(0, 0, W, H);
    }
  }
}

// ── Layer Renderers ──
function drawLayer(layer, t, scene) {
  ctx.save();
  const alpha = layer.opacity !== undefined ? layer.opacity : 1;
  ctx.globalAlpha = alpha;

  switch(layer.type) {
    case 'text': drawTextLayer(layer, t); break;
    case 'lower_third': drawLowerThird(layer, t); break;
    case 'logo': drawLogo(layer, t); break;
    case 'light_ray': drawLightRays(layer, t); break;
    case 'lens_flare': drawLensFlare(layer, t); break;
    case 'particle_system': drawParticleSystem(layer, t); break;
    case 'shape': drawShape(layer, t); break;
    case 'energy_burst': drawEnergyBurst(layer, t); break;
    case 'scanlines': drawScanlines(layer, t); break;
    case 'hexgrid': drawHexGrid(layer, t); break;
    case 'title_card': drawTitleCard(layer, t); break;
    case 'countdown': drawCountdown(layer, t); break;
    case 'waveform': drawWaveform(layer, t); break;
  }
  ctx.restore();
}

function drawTextLayer(layer, t) {
  const x = (layer.x || 0.5) * W;
  const y = (layer.y || 0.5) * H;
  const size = (layer.size || 0.05) * H;
  const font = layer.font || 'Impact';
  const text = layer.content || '';
  const color = layer.color || '#FFFFFF';
  const fx = layer.fx || 'none';

  ctx.font = \`\${layer.weight || 'bold'} \${size}px \${font}\`;
  ctx.textAlign = layer.align || 'center';
  ctx.textBaseline = 'middle';

  switch(fx) {
    case 'glitch': {
      // Red/cyan channel split
      const offset = Math.sin(time * 20) * 8;
      ctx.fillStyle = 'rgba(255,0,0,0.7)';
      ctx.fillText(text, x + offset, y);
      ctx.fillStyle = 'rgba(0,255,255,0.7)';
      ctx.fillText(text, x - offset, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      break;
    }
    case 'typewriter': {
      const chars = Math.floor(t * text.length * 1.2);
      const shown = text.slice(0, Math.min(chars, text.length));
      ctx.fillStyle = color;
      ctx.shadowBlur = layer.glow || 0;
      ctx.shadowColor = color;
      ctx.fillText(shown + (Math.floor(time * 4) % 2 ? '|' : ''), x, y);
      break;
    }
    case 'split_reveal': {
      const progress = Math.min(t * 2, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y - size, W, size * eased);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillText(text, x, y - size/2 + size * eased);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, W, size * eased);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillText(text, x, y + size/2 - size * eased);
      ctx.restore();
      break;
    }
    case 'fade_up': {
      const progress = Math.min(t * 3, 1);
      ctx.globalAlpha = progress;
      ctx.translate(0, (1 - progress) * 50);
      ctx.fillStyle = color;
      ctx.shadowBlur = (layer.glow || 0) * progress;
      ctx.shadowColor = color;
      ctx.fillText(text, x, y);
      break;
    }
    case 'morph': {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(0.5 + t * 0.5, 0.5 + t * 0.5);
      ctx.globalAlpha = t;
      ctx.fillStyle = color;
      ctx.fillText(text, 0, 0);
      ctx.restore();
      break;
    }
    default: {
      ctx.fillStyle = color;
      ctx.shadowBlur = layer.glow || 0;
      ctx.shadowColor = layer.glowColor || color;
      if (layer.stroke) {
        ctx.strokeStyle = layer.stroke;
        ctx.lineWidth = layer.strokeWidth || 2;
        ctx.strokeText(text, x, y);
      }
      ctx.fillText(text, x, y);
    }
  }
}

function drawLowerThird(layer, t) {
  const x = W * 0.05;
  const y = H * (layer.y || 0.78);
  const w = W * 0.9;
  const barH = H * 0.06;
  const progress = Math.min(t * 3, 1);
  const eased = 1 - Math.pow(1 - progress, 4);

  // Animated bar slide-in
  const barW = w * eased;

  // Main accent bar
  const barGrad = ctx.createLinearGradient(x, 0, x + barW, 0);
  barGrad.addColorStop(0, layer.accentColor || '#E50914');
  barGrad.addColorStop(0.7, layer.accentColor2 || '#FF6B35');
  barGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = barGrad;
  ctx.fillRect(x, y - 4, barW, 4);

  // Text background
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x, y, barW, barH);

  if (progress > 0.3) {
    const textProgress = (progress - 0.3) / 0.7;
    ctx.globalAlpha = textProgress;

    // Name/Title
    ctx.font = \`bold \${H * 0.03}px Helvetica Neue, Arial\`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(layer.name || 'CHARACTER NAME', x + 16, y + 8);

    // Role/Subtitle
    ctx.font = \`\${H * 0.02}px Helvetica Neue, Arial\`;
    ctx.fillStyle = layer.accentColor || '#E50914';
    ctx.fillText(layer.role || 'Role / Titre', x + 16, y + 8 + H * 0.032);
  }
}

function drawLogo(layer, t) {
  const cx = (layer.x || 0.5) * W;
  const cy = (layer.y || 0.5) * H;
  const size = (layer.size || 0.15) * H;
  const text = layer.content || 'LOGO';
  const fx = layer.fx || 'reveal';
  const progress = Math.min(t * 2, 1);

  switch(fx) {
    case 'particle_assemble': {
      // Letters fly in from random positions
      const letters = text.split('');
      letters.forEach((letter, i) => {
        const lx = cx + (i - letters.length/2) * size * 0.6;
        const startX = lx + (Math.random() - 0.5) * W;
        const startY = cy + (Math.random() - 0.5) * H;
        const eased = 1 - Math.pow(1 - Math.min(progress * 1.5 - i * 0.1, 1), 3);
        const px = startX + (lx - startX) * Math.max(0, eased);
        const py = startY + (cy - startY) * Math.max(0, eased);
        ctx.save();
        ctx.globalAlpha = Math.max(0, eased);
        ctx.font = \`bold \${size}px Impact\`;
        ctx.fillStyle = layer.color || '#FFD700';
        ctx.shadowBlur = 30;
        ctx.shadowColor = layer.glowColor || '#FFD700';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, px, py);
        ctx.restore();
      });
      break;
    }
    case 'energy_reveal': {
      // Energy burst then logo appears
      if (progress < 0.5) {
        const bursts = Math.floor(progress * 20);
        for (let i = 0; i < bursts; i++) {
          const angle = (i / 20) * Math.PI * 2;
          const dist = progress * H * 0.4;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist);
          ctx.strokeStyle = \`hsla(\${i * 18}, 100%, 70%, \${1-progress*2})\`;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      } else {
        const logoProgress = (progress - 0.5) * 2;
        ctx.save();
        ctx.globalAlpha = logoProgress;
        ctx.shadowBlur = 60 * (1 - logoProgress * 0.5);
        ctx.shadowColor = layer.color || '#FFFFFF';
        ctx.font = \`bold \${size}px Impact\`;
        ctx.fillStyle = layer.color || '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, cy);
        ctx.restore();
      }
      break;
    }
    default: {
      ctx.globalAlpha = progress;
      ctx.font = \`bold \${size}px Impact\`;
      ctx.fillStyle = layer.color || '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur = 20 * progress;
      ctx.shadowColor = layer.color || '#FFF';
      ctx.fillText(text, cx, cy);
    }
  }
}

function drawLightRays(layer, t) {
  const cx = (layer.x || 0.5) * W;
  const cy = (layer.y || 0.2) * H;
  const rays = layer.rays || 12;
  const color = layer.color || 'rgba(255,220,100,0.15)';
  const length = (layer.length || 1.5) * H;
  const rotation = t * (layer.rotationSpeed || 0.1) * Math.PI * 2;

  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2 + rotation;
    const spread = (Math.PI / rays) * (layer.spread || 0.5);
    const gradient = ctx.createLinearGradient(cx, cy, 
      cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle - spread) * length, cy + Math.sin(angle - spread) * length);
    ctx.lineTo(cx + Math.cos(angle + spread) * length, cy + Math.sin(angle + spread) * length);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

function drawLensFlare(layer, t) {
  const cx = (layer.x || 0.3) * W;
  const cy = (layer.y || 0.15) * H;
  const intensity = layer.intensity || 1;
  const pulse = 0.8 + Math.sin(time * 3) * 0.2;

  // Main bright spot
  const mainGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 150 * intensity);
  mainGrad.addColorStop(0, \`rgba(255,255,255,\${0.9 * pulse})\`);
  mainGrad.addColorStop(0.1, \`rgba(255,220,150,\${0.6 * pulse})\`);
  mainGrad.addColorStop(0.4, \`rgba(255,150,50,\${0.2 * pulse})\`);
  mainGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mainGrad;
  ctx.fillRect(0, 0, W, H);

  // Flare ghosts along diagonal
  const flarePositions = [0.3, 0.5, 0.7, 0.85, 1.1, 1.4];
  const flareColors = ['rgba(100,150,255,0.4)', 'rgba(255,100,100,0.3)', 
                       'rgba(100,255,150,0.3)', 'rgba(255,200,50,0.4)',
                       'rgba(200,100,255,0.3)', 'rgba(100,200,255,0.2)'];
  const flareSize = [80, 40, 60, 30, 50, 90];
  
  flarePositions.forEach((pos, i) => {
    const fx2 = W/2 + (W/2 - cx) * pos;
    const fy = H/2 + (H/2 - cy) * pos;
    const fs = flareSize[i] * intensity * pulse;
    const fg = ctx.createRadialGradient(fx2, fy, 0, fx2, fy, fs);
    fg.addColorStop(0, flareColors[i]);
    fg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fg;
    ctx.fillRect(0, 0, W, H);

    // Star burst on main flare
    if (i === 0) {
      for (let r = 0; r < 6; r++) {
        const angle = r * Math.PI / 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * 200, cy + Math.sin(angle) * 200);
        ctx.strokeStyle = \`rgba(255,255,200,\${0.15 * pulse})\`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  });
}

function drawParticleSystem(layer, t) {
  const cx = (layer.x || 0.5) * W;
  const cy = (layer.y || 0.5) * H;
  const rate = layer.rate || 5;
  const color = layer.color || '#FFD700';
  const pType = layer.particleType || 'circle';
  const spread = (layer.spread || 1) * W * 0.5;

  // Emit new particles
  for (let i = 0; i < rate; i++) {
    if (particles.length < 500) {
      const sx = cx + (Math.random() - 0.5) * spread * 0.1;
      const sy = cy + (Math.random() - 0.5) * spread * 0.1;
      particles.push(new Particle(sx, sy, {
        speed: layer.speed || 3,
        color: Array.isArray(layer.colors) 
          ? layer.colors[Math.floor(Math.random() * layer.colors.length)]
          : color,
        minSize: layer.minSize || 2,
        maxSize: layer.maxSize || 6,
        type: pType,
        rise: layer.rise || 0,
        gravity: layer.gravity || 0,
        glow: layer.glow !== false
      }));
    }
  }

  // Update and draw
  particles = particles.filter(p => p.life > 0);
  particles.forEach(p => { p.update(); p.draw(ctx); });
}

function drawEnergyBurst(layer, t) {
  const cx = (layer.x || 0.5) * W;
  const cy = (layer.y || 0.5) * H;
  const progress = t;
  const color = layer.color || '#00FFFF';
  const rings = layer.rings || 3;

  for (let r = 0; r < rings; r++) {
    const ringProgress = Math.max(0, (progress - r * 0.1));
    const radius = ringProgress * H * 0.6;
    const alpha = Math.max(0, 1 - ringProgress * 1.5);
    const width = Math.max(0.5, (1 - ringProgress) * 8);

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color.replace(')', \`, \${alpha})\`).replace('rgb', 'rgba');
    ctx.lineWidth = width;
    ctx.shadowBlur = 20;
    ctx.shadowColor = color;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Core glow
  const coreSize = 50 * (1 - progress * 0.5);
  if (coreSize > 0) {
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreSize);
    cg.addColorStop(0, color);
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cg;
    ctx.fillRect(cx - coreSize, cy - coreSize, coreSize * 2, coreSize * 2);
  }
}

function drawHexGrid(layer, t) {
  const cols = layer.cols || 10;
  const color = layer.color || 'rgba(0,200,255,0.15)';
  const hexSize = W / (cols * 2);
  const pulse = Math.sin(time * 2) * 0.3 + 0.7;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  for (let q = -2; q < cols + 2; q++) {
    for (let r = -2; r < Math.ceil(H / (hexSize * 1.73)) + 2; r++) {
      const x = hexSize * (3/2 * q) + Math.sin(time + q * r) * 2;
      const y = hexSize * (Math.sqrt(3)/2 * q + Math.sqrt(3) * r);
      const active = Math.sin(q * 0.5 + r * 0.7 + time * 2) > 0.7;
      
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (i * 60) * Math.PI / 180;
        const px = x + hexSize * Math.cos(angle);
        const py = y + hexSize * Math.sin(angle);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      if (active) {
        ctx.fillStyle = (layer.activeColor || 'rgba(0,200,255,0.3)').replace(')', \`, \${pulse})\`);
        ctx.fill();
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawScanlines(layer, t) {
  const spacing = layer.spacing || 4;
  const alpha = layer.alpha || 0.15;
  ctx.fillStyle = \`rgba(0,0,0,\${alpha})\`;
  for (let y = 0; y < H; y += spacing) {
    ctx.fillRect(0, y, W, spacing * 0.5);
  }
  // Rolling scan
  if (layer.rolling) {
    const rollY = (time * 100) % H;
    const rg = ctx.createLinearGradient(0, rollY - 20, 0, rollY + 20);
    rg.addColorStop(0, 'rgba(255,255,255,0)');
    rg.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, rollY - 20, W, 40);
  }
}

function drawTitleCard(layer, t) {
  const progress = Math.min(t * 2, 1);
  const eased = 1 - Math.pow(1 - progress, 3);

  // Black bars animation (cinematic letterbox)
  if (layer.letterbox) {
    const barH = H * 0.12 * (1 - eased);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, barH);
    ctx.fillRect(0, H - barH, W, barH);
  }

  const cx = W / 2;
  const cy = H * (layer.y || 0.5);

  // Title
  ctx.save();
  ctx.globalAlpha = eased;
  ctx.font = \`\${layer.titleWeight || '900'} \${H * (layer.titleSize || 0.07)}px \${layer.font || 'Impact'}\`;
  ctx.fillStyle = layer.titleColor || '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = \`\${(1-eased) * 20}px\`;
  ctx.shadowBlur = 40 * eased;
  ctx.shadowColor = layer.glowColor || 'rgba(255,150,0,0.8)';
  ctx.fillText((layer.title || 'TITLE').toUpperCase(), cx, cy);

  // Subtitle
  if (layer.subtitle) {
    ctx.globalAlpha = Math.max(0, eased - 0.3);
    ctx.font = \`300 \${H * 0.025}px Helvetica Neue, Arial\`;
    ctx.fillStyle = layer.subtitleColor || 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = 0;
    ctx.letterSpacing = '4px';
    ctx.fillText(layer.subtitle.toUpperCase(), cx, cy + H * 0.07);
  }
  ctx.restore();
}

function drawShape(layer, t) {
  const x = (layer.x || 0.5) * W;
  const y = (layer.y || 0.5) * H;
  const size = (layer.size || 0.1) * H;
  const color = layer.color || '#FFFFFF';
  const rotation = t * (layer.rotationSpeed || 0) * Math.PI * 2;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.fillStyle = color;
  ctx.strokeStyle = layer.stroke || color;
  ctx.lineWidth = layer.strokeWidth || 2;

  switch(layer.shape) {
    case 'triangle': {
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.866, size * 0.5);
      ctx.lineTo(-size * 0.866, size * 0.5);
      ctx.closePath();
      layer.filled !== false ? ctx.fill() : ctx.stroke();
      break;
    }
    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.6, 0);
      ctx.lineTo(0, size);
      ctx.lineTo(-size * 0.6, 0);
      ctx.closePath();
      layer.filled !== false ? ctx.fill() : ctx.stroke();
      break;
    }
    case 'ring': {
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, Math.PI * 2);
      ctx.lineWidth = size * 0.1;
      ctx.stroke();
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, Math.PI * 2);
      layer.filled !== false ? ctx.fill() : ctx.stroke();
    }
  }
  ctx.restore();
}

function drawWaveform(layer, t) {
  const cx = W / 2;
  const cy = (layer.y || 0.5) * H;
  const amplitude = (layer.amplitude || 0.08) * H;
  const frequency = layer.frequency || 3;
  const color = layer.color || '#00FFFF';
  const bars = layer.bars || 60;

  ctx.beginPath();
  for (let i = 0; i <= bars; i++) {
    const x = (i / bars) * W;
    const noise = Math.sin(i * frequency + time * 8) * 
                  Math.cos(i * frequency * 0.7 + time * 5) * amplitude;
    const y = cy + noise;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowBlur = 15;
  ctx.shadowColor = color;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ── Post-Processing FX ──
function applyFX(fx, t) {
  if (!fx || fx.length === 0) return;

  fx.forEach(effect => {
    switch(effect) {
      case 'film_grain': {
        const grain = ctx.createImageData(W, H);
        const d = grain.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = (Math.random() - 0.5) * 40;
          d[i] = d[i+1] = d[i+2] = 128 + n;
          d[i+3] = 15;
        }
        ctx.putImageData(grain, 0, 0);
        break;
      }
      case 'vignette': {
        const vg = ctx.createRadialGradient(W/2, H/2, H * 0.3, W/2, H/2, H * 0.85);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, \`rgba(0,0,0,\${grade.vignette})\`);
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      case 'chromatic_aberration': {
        const img = ctx.getImageData(0, 0, W, H);
        const shifted = ctx.createImageData(W, H);
        const offset = Math.sin(time * 10) * 3 + 2;
        for (let y2 = 0; y2 < H; y2++) {
          for (let x2 = 0; x2 < W; x2++) {
            const i = (y2 * W + x2) * 4;
            const ri = (y2 * W + Math.min(W-1, x2 + offset)) * 4;
            const bi = (y2 * W + Math.max(0, x2 - offset)) * 4;
            shifted.data[i] = img.data[ri];
            shifted.data[i+1] = img.data[i+1];
            shifted.data[i+2] = img.data[bi+2];
            shifted.data[i+3] = img.data[i+3];
          }
        }
        ctx.putImageData(shifted, 0, 0);
        break;
      }
      case 'depth_blur': {
        // Simplified depth blur via radial blur at edges
        const dbg = ctx.createRadialGradient(W/2, H/2, H * 0.15, W/2, H/2, H * 0.6);
        dbg.addColorStop(0, 'rgba(0,0,0,0)');
        dbg.addColorStop(1, 'rgba(0,0,0,0.1)');
        ctx.filter = 'blur(1px)';
        ctx.globalCompositeOperation = 'destination-atop';
        ctx.fillStyle = dbg;
        ctx.fillRect(0, 0, W, H);
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
    }
  });
}

function applyColorGrade() {
  // Apply color grading via CSS filter
  canvas.style.filter = \`saturate(\${grade.sat}) brightness(\${1 + grade.bright})\`;
}

// ── Main Render Loop ──
function getSceneAt(timeS) {
  return WVML.timeline.find(s => timeS >= s.start && timeS < s.end);
}

function renderFrame(frameNum) {
  currentFrame = frameNum;
  time = frameNum / FPS;
  const scene = getSceneAt(time);
  if (!scene) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    return;
  }

  const sceneT = (time - scene.start) / (scene.end - scene.start);
  const sceneDuration = scene.end - scene.start;
  const sceneElapsed = time - scene.start;

  // 1. Background
  drawBackground(scene.background, sceneT);

  // 2. Camera transform
  applyCamera(scene, sceneT);

  // 3. Layers
  if (scene.layers) {
    scene.layers.forEach(layer => {
      const layerStart = layer.start || 0;
      const layerEnd = layer.end || sceneDuration;
      if (sceneElapsed >= layerStart && sceneElapsed < layerEnd) {
        const layerT = (sceneElapsed - layerStart) / (layerEnd - layerStart);
        drawLayer(layer, layerT, scene);
      }
    });
  }

  ctx.restore(); // Restore camera transform

  // 4. FX
  if (scene.fx) applyFX(scene.fx, sceneT);

  // 5. Transitions
  if (scene.transition_in && sceneT < 0.1) {
    const tp = sceneT / 0.1;
    ctx.fillStyle = \`rgba(0,0,0,\${1 - tp})\`;
    ctx.fillRect(0, 0, W, H);
  }
  if (scene.transition_out && sceneT > 0.9) {
    const tp = (sceneT - 0.9) / 0.1;
    ctx.fillStyle = \`rgba(0,0,0,\${tp})\`;
    ctx.fillRect(0, 0, W, H);
  }
}

applyColorGrade();

// Expose render function to Puppeteer
window.renderFrame = renderFrame;
window.totalFrames = totalFrames;
window.WVML = WVML;
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// ██  VIDEO GENERATOR — Puppeteer + FFmpeg
// ═══════════════════════════════════════════════════════════════

async function generateVideo(wvml, jobId) {
  const framesDir = path.join(FRAMES_DIR, jobId);
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: getChromePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--single-process',
      '--no-zygote',
      '--window-size=1080,1920'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
  const html = buildRendererHTML(wvml);
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const fps = wvml.project?.fps || 30;
  const duration = wvml.project?.duration || 15;
  const totalFrames = Math.ceil(fps * duration);

  app.log.info(`Rendering ${totalFrames} frames...`);

  for (let frame = 0; frame < totalFrames; frame++) {
    await page.evaluate((f) => window.renderFrame(f), frame);
    const framePath = path.join(framesDir, `frame_${String(frame).padStart(6, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1920 } });

    if (frame % 30 === 0) app.log.info(`Frame ${frame}/${totalFrames}`);
  }

  await browser.close();

  // Assemble MP4 via ffmpeg
  const outputPath = path.join(OUTPUTS_DIR, `${jobId}.mp4`);
  const cmd = `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%06d.png" \
    -vf "scale=1080:1920:flags=lanczos" \
    -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
    -movflags +faststart "${outputPath}"`;

  await new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });

  // Cleanup frames
  fs.rmSync(framesDir, { recursive: true, force: true });

  return outputPath;
}

// ═══════════════════════════════════════════════════════════════
// ██  DEMO WVML FALLBACK
// ═══════════════════════════════════════════════════════════════

function getDemoWVML(prompt, style) {
  return {
    project: { duration: 10, fps: 30, width: 1080, height: 1920, style: style || 'marvel' },
    audio: { bgm: 'cinematic_epic.mp3', bpm: 120 },
    camera: { globalShake: 0.1, depthOfField: true },
    timeline: [
      {
        id: 'intro', start: 0, end: 4,
        background: { type: 'particle_field', baseColor: '#000010', nebulaColors: ['rgba(100,0,200,0.2)', 'rgba(200,0,100,0.15)'] },
        camera: { type: 'dolly_in', intensity: 0.8 },
        layers: [
          { type: 'light_ray', x: 0.5, y: 0.1, rays: 16, color: 'rgba(255,150,50,0.12)', length: 2.0, rotationSpeed: 0.05 },
          { type: 'particle_system', x: 0.5, y: 0.5, rate: 8, colors: ['#FFD700','#FF6B00','#FF0050'], minSize: 1, maxSize: 4, speed: 4, glow: true },
          { type: 'text', content: prompt.slice(0, 30), x: 0.5, y: 0.45, size: 0.07, color: '#FFFFFF', fx: 'glitch', glow: 40 },
          { type: 'text', content: 'WIVIDAI', x: 0.5, y: 0.55, size: 0.05, color: '#FFD700', fx: 'typewriter' }
        ],
        fx: ['vignette', 'film_grain'],
        transition_in: true
      },
      {
        id: 'main', start: 4, end: 8,
        background: { type: 'city' },
        camera: { type: 'parallax', intensity: 0.6 },
        layers: [
          { type: 'lens_flare', x: 0.2, y: 0.1, intensity: 1.2 },
          { type: 'hexgrid', cols: 8, color: 'rgba(0,200,255,0.12)' },
          { type: 'title_card', title: 'CINEMATIC', subtitle: 'Powered by WIVIDAI', y: 0.5, letterbox: true, glowColor: 'rgba(0,200,255,0.8)' },
          { type: 'lower_third', name: 'AI GENERATED', role: 'Zero-Cost Browser Rendering', y: 0.78, accentColor: '#00CFFF' }
        ],
        fx: ['vignette', 'chromatic_aberration']
      },
      {
        id: 'outro', start: 8, end: 10,
        background: { type: 'radial_gradient', colors: ['#0a0020', '#000'] },
        camera: { type: 'dolly_out', intensity: 0.5 },
        layers: [
          { type: 'energy_burst', x: 0.5, y: 0.5, color: '#FFD700', rings: 4 },
          { type: 'logo', content: 'WIVIDAI', x: 0.5, y: 0.5, size: 0.12, color: '#FFFFFF', fx: 'energy_reveal' }
        ],
        fx: ['vignette', 'film_grain'],
        transition_out: true
      }
    ]
  };
}

// ═══════════════════════════════════════════════════════════════
// ██  API ROUTES
// ═══════════════════════════════════════════════════════════════

// In-memory job store (use Redis for production)
const jobs = {};

app.post('/api/generate', async (req, reply) => {
  const { prompt, geminiKey, openrouterKey, style, wvml: manualWvml } = req.body;

  if (!prompt && !manualWvml) {
    return reply.status(400).send({ error: 'prompt or wvml required' });
  }

  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 0, createdAt: Date.now() };

  reply.send({ jobId, status: 'processing' });

  // Async generation
  (async () => {
    try {
      // Step 1: Generate WVML
      let wvml = manualWvml;
      if (!wvml) {
        jobs[jobId].step = 'ai_generation';
        const result = await generateWVML(prompt, geminiKey, openrouterKey, style);
        wvml = result.wvml;
        jobs[jobId].provider = result.provider;
        jobs[jobId].wvml = wvml;
      }

      // Step 2: Render video
      jobs[jobId].step = 'rendering';
      const videoPath = await generateVideo(wvml, jobId);
      const filename = path.basename(videoPath);

      jobs[jobId].status = 'done';
      jobs[jobId].videoUrl = `/videos/${filename}`;
      jobs[jobId].progress = 100;

    } catch (err) {
      app.log.error(err);
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message;
    }
  })();
});

app.get('/api/status/:jobId', async (req, reply) => {
  const job = jobs[req.params.jobId];
  if (!job) return reply.status(404).send({ error: 'Job not found' });
  return job;
});

app.get('/api/wvml/:jobId', async (req, reply) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.wvml) return reply.status(404).send({ error: 'WVML not found' });
  return job.wvml;
});

app.get('/health', async () => ({ status: 'ok', version: '1.0.0', engine: 'WIVIDAI Cinematic Engine' }));

// ═══════════════════════════════════════════════════════════════
// ██  START
// ═══════════════════════════════════════════════════════════════

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  console.log(\`
╔══════════════════════════════════════╗
║   WIVIDAI CINEMATIC ENGINE v1.0.0   ║
║   Port: \${PORT}                        ║
║   Status: READY                      ║
╚══════════════════════════════════════╝
  \`);
});

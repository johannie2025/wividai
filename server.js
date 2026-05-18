'use strict';

// ═══════════════════════════════════════════════════════════════
//  INTENTFILM  —  Core Render Engine  v2.0
//  Fixes: text positioning, multi-format, real animations,
//         Unsplash backgrounds, green screen / transparent bg
//  Optimisé: Render.com free tier (512MB RAM, 0.1 CPU)
// ═══════════════════════════════════════════════════════════════

process.on('uncaughtException',  (err)    => console.error('❌ uncaughtException:', err.message));
process.on('unhandledRejection', (reason) => console.error('❌ unhandledRejection:', reason?.message || reason));

const express    = require('express');
const { spawn }  = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const https      = require('https');
const http       = require('http');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── Config ───────────────────────────────────────────────────────
const PORT           = process.env.PORT        || 3000;
const BASE_URL       = process.env.BASE_URL    || `http://localhost:${PORT}`;
const RENDER_DIR     = path.join(process.cwd(), 'renders');
const ASSETS_DIR     = path.join(os.tmpdir(), 'intentfilm_assets');
const FFMPEG_BIN     = process.env.FFMPEG_PATH  || 'ffmpeg';
const FFPROBE_BIN    = process.env.FFPROBE_PATH || 'ffprobe';
const GEMINI_KEY     = process.env.GEMINI_API_KEY     || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const UNSPLASH_KEY   = process.env.UNSPLASH_ACCESS_KEY || '';

fs.mkdirSync(RENDER_DIR,  { recursive: true });
fs.mkdirSync(ASSETS_DIR,  { recursive: true });

// ── Formats — résolutions réelles (adaptées free tier: max 720p) ──
// IMPORTANT: les positions X/Y dans le JSON sont en pourcentage (0.0–1.0)
// ou en expressions FFmpeg natives (w, h, tw, th)
const FORMATS = {
  tiktok_vertical:   { w: 540,  h: 960,  label: 'TikTok / Reels / Shorts (9:16)' },
  youtube_landscape: { w: 960,  h: 540,  label: 'YouTube paysage (16:9)'          },
  youtube_shorts:    { w: 540,  h: 960,  label: 'YouTube Shorts (9:16)'            },
  instagram_square:  { w: 720,  h: 720,  label: 'Instagram carré (1:1)'            },
  instagram_story:   { w: 540,  h: 960,  label: 'Instagram Story (9:16)'           },
  twitter_landscape: { w: 854,  h: 480,  label: 'X / Twitter (16:9)'               },
  greenscreen:       { w: 960,  h: 540,  label: 'Green Screen (16:9)'              },
};

const XFADE_TRANSITIONS = [
  'fade','wipeleft','wiperight','wipeup','wipedown',
  'slideleft','slideright','slideup','slidedown',
  'circlecrop','rectcrop','distance','fadeblack','fadewhite',
  'radial','smoothleft','smoothright','smoothup','smoothdown',
  'circleopen','circleclose','horzopen','horzclose','vertopen','vertclose',
  'diagtl','diagtr','diagbl','diagbr',
  'dissolve','pixelize','squeezeh','squeezev',
];

// ─────────────────────────────────────────────────────────────────
//  JOB STORE
// ─────────────────────────────────────────────────────────────────
const jobs = new Map();

function createJob(sceneGraph, source = 'json') {
  const id = uuidv4();
  jobs.set(id, { id, status: 'queued', progress: 0, createdAt: Date.now(),
    source, sceneGraph, outputFile: null, downloadUrl: null, error: null, log: [] });
  return id;
}
function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}
setInterval(() => {
  const limit = Date.now() - 24 * 3600 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < limit) {
      if (job.outputFile && fs.existsSync(job.outputFile)) fs.unlinkSync(job.outputFile);
      jobs.delete(id);
    }
  }
}, 3600 * 1000);

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────

function escapeDrawtext(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Résout une position X ou Y en expression FFmpeg correcte
 * Supporte:
 *   - Nombre 0–1 → traité comme ratio (ex: 0.5 → w*0.5 ou h*0.5)
 *   - Nombre >1  → pixel absolu dans la résolution de RÉFÉRENCE (1080×1920 ou 1920×1080)
 *                  et on le normalise en ratio
 *   - String FFmpeg (w, h, tw, th, ...) → passé tel quel
 *   - "center" → "(w-tw)/2" ou "(h-th)/2"
 */
function resolvePos(val, axis, W, H, refW, refH) {
  if (val === undefined || val === null) {
    return axis === 'x' ? '(w-tw)/2' : '(h-th)/2';
  }
  if (val === 'center') {
    return axis === 'x' ? '(w-tw)/2' : '(h-th)/2';
  }
  if (typeof val === 'number') {
    if (val >= 0 && val <= 1) {
      // ratio: 0.5 → w*0.5 ou h*0.5
      const dim = axis === 'x' ? 'w' : 'h';
      return `${dim}*${val}`;
    } else {
      // pixel absolu dans le référentiel original → normaliser
      const ref = axis === 'x' ? (refW || 1080) : (refH || 1920);
      const ratio = val / ref;
      const dim   = axis === 'x' ? 'w' : 'h';
      return `${dim}*${ratio.toFixed(6)}`;
    }
  }
  // String FFmpeg → passer directement (ex: "(w-tw)/2", "h*0.3", etc.)
  return String(val);
}

/**
 * Résout une dimension (width/height) en expression FFmpeg
 */
function resolveDim(val, axis, W, H, refW, refH) {
  if (val === undefined || val === null) return axis === 'w' ? 'w' : 'h';
  if (typeof val === 'number') {
    if (val > 0 && val <= 1) {
      return `${axis === 'w' ? 'w' : 'h'}*${val}`;
    } else {
      const ref = axis === 'w' ? (refW || 1080) : (refH || 1920);
      const ratio = val / ref;
      return `${axis === 'w' ? 'w' : 'h'}*${ratio.toFixed(6)}`;
    }
  }
  return String(val);
}

/**
 * Résout fontSize en pixels adaptés à la résolution cible
 * Si fontSize est en référentiel 1920H, on le scale
 */
function resolveFontSize(val, H, refH) {
  if (!val) return Math.round(H * 0.06); // 6% de hauteur par défaut
  if (typeof val === 'number') {
    if (val <= 1) return Math.round(H * val);
    if (val > H * 0.5) {
      // probablement en référentiel plus grand
      const ref = refH || 1920;
      return Math.max(16, Math.round(val * H / ref));
    }
    return val;
  }
  return 60;
}

function findFont(bold = false) {
  const candidates = bold
    ? ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
       '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
       '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
       '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
       'C:/Windows/Fonts/arialbd.ttf']
    : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
       '/usr/share/fonts/TTF/DejaVuSans.ttf',
       '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
       '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
       'C:/Windows/Fonts/arial.ttf'];
  for (const f of candidates) if (fs.existsSync(f)) return f;
  return '';
}

// ─────────────────────────────────────────────────────────────────
//  TÉLÉCHARGEMENT D'IMAGE UNSPLASH
// ─────────────────────────────────────────────────────────────────

/**
 * Télécharge une image Unsplash et la sauvegarde en /tmp
 * Retourne le chemin local
 */
async function downloadUnsplashImage(query, width, height) {
  if (!UNSPLASH_KEY) return null;

  return new Promise((resolve) => {
    const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=${width > height ? 'landscape' : 'portrait'}&client_id=${UNSPLASH_KEY}`;

    https.get(url, { headers: { 'Accept-Version': 'v1' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const imgUrl = json?.urls?.regular || json?.urls?.full;
          if (!imgUrl) return resolve(null);

          const filename = path.join(ASSETS_DIR, `unsplash_${Date.now()}.jpg`);
          const proto = imgUrl.startsWith('https') ? https : http;
          const file = fs.createWriteStream(filename);
          proto.get(imgUrl, (imgRes) => {
            imgRes.pipe(file);
            file.on('finish', () => { file.close(); resolve(filename); });
            file.on('error', () => resolve(null));
          }).on('error', () => resolve(null));
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─────────────────────────────────────────────────────────────────
//  BUILD FFMPEG COMMAND — Scene Graph → args FFmpeg
// ─────────────────────────────────────────────────────────────────

async function buildFfmpegCmd(jobId, sceneGraph) {
  const fmt  = FORMATS[sceneGraph.format] || FORMATS.tiktok_vertical;
  const W    = sceneGraph.resolution?.width  || fmt.w;
  const H    = sceneGraph.resolution?.height || fmt.h;
  const FPS  = sceneGraph.fps || 30;

  // Référentiel de conception (pour normaliser les positions)
  // Si le JSON a été écrit pour 1080×1920, on détecte et normalise
  const refW = sceneGraph.referenceWidth  || (W > H ? 1920 : 1080);
  const refH = sceneGraph.referenceHeight || (W > H ? 1080 : 1920);

  const scenes = sceneGraph.scenes || [];
  if (scenes.length === 0) throw new Error('Aucune scène définie');

  const isGreenScreen = sceneGraph.format === 'greenscreen' || sceneGraph.greenscreen === true;

  const font     = findFont(false);
  const fontBold = findFont(true);
  const inputs   = [];
  const filters  = [];
  let inputIdx   = 0;
  const sceneLabels = [];
  const tmpFiles    = [];

  // ── Pré-télécharger les images de fond ──────────────────────
  for (let si = 0; si < scenes.length; si++) {
    const scene = scenes[si];
    const bg = scene.background || {};
    if (bg.type === 'unsplash' && bg.query && UNSPLASH_KEY) {
      const imgPath = await downloadUnsplashImage(bg.query, W, H);
      if (imgPath) {
        bg._localPath = imgPath;
        tmpFiles.push(imgPath);
      }
    }
  }

  // ── Construire inputs + filters par scène ───────────────────
  for (let si = 0; si < scenes.length; si++) {
    const scene    = scenes[si];
    const duration = scene.duration || 3;
    const bg       = scene.background || { type: 'color', color: '#000000' };
    const elements = scene.elements   || [];

    let bgLabel = `bg${si}`;

    // ── Background ──────────────────────────────────────────
    if (isGreenScreen) {
      // Fond vert pur pour chroma key
      inputs.push('-f', 'lavfi', '-i', `color=c=0x00ff00:s=${W}x${H}:d=${duration}:r=${FPS}`);
      filters.push(`[${inputIdx}:v]setsar=1[${bgLabel}]`);
      inputIdx++;

    } else if (bg.type === 'transparent') {
      // Fond vert (utilisateur veut transparent → green screen)
      inputs.push('-f', 'lavfi', '-i', `color=c=0x00ff00:s=${W}x${H}:d=${duration}:r=${FPS}`);
      filters.push(`[${inputIdx}:v]setsar=1[${bgLabel}]`);
      inputIdx++;

    } else if (bg.type === 'image' || (bg.type === 'unsplash' && bg._localPath)) {
      const imgPath = bg._localPath || bg.path || '';
      if (imgPath && fs.existsSync(imgPath)) {
        // Image: input + scale + loop
        inputs.push('-loop', '1', '-t', String(duration), '-i', imgPath);
        // Scale + crop pour remplir le format cible
        filters.push(`[${inputIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS}[${bgLabel}]`);
        inputIdx++;
      } else {
        // Fallback noir
        inputs.push('-f', 'lavfi', '-i', `color=c=0x111111:s=${W}x${H}:d=${duration}:r=${FPS}`);
        filters.push(`[${inputIdx}:v]setsar=1[${bgLabel}]`);
        inputIdx++;
      }

    } else if (bg.type === 'video') {
      const vidPath = bg.path || '';
      if (vidPath && fs.existsSync(vidPath)) {
        inputs.push('-stream_loop', '-1', '-t', String(duration), '-i', vidPath);
        filters.push(`[${inputIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS}[${bgLabel}]`);
        inputIdx++;
      } else {
        inputs.push('-f', 'lavfi', '-i', `color=c=0x111111:s=${W}x${H}:d=${duration}:r=${FPS}`);
        filters.push(`[${inputIdx}:v]setsar=1[${bgLabel}]`);
        inputIdx++;
      }

    } else if (bg.type === 'gradient') {
      const c1 = (bg.color1 || bg.colors?.[0] || '#000000').replace('#', '');
      const c2 = (bg.color2 || bg.colors?.[1] || '#333333').replace('#', '');
      const r1 = parseInt(c1.slice(0,2),16), g1 = parseInt(c1.slice(2,4),16), b1 = parseInt(c1.slice(4,6),16);
      const r2 = parseInt(c2.slice(0,2),16), g2 = parseInt(c2.slice(2,4),16), b2 = parseInt(c2.slice(4,6),16);
      inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${duration}:r=${FPS}`);
      const geq = `geq=r='${r1}+(${r2}-${r1})*Y/H':g='${g1}+(${g2}-${g1})*Y/H':b='${b1}+(${b2}-${b1})*Y/H'`;
      filters.push(`[${inputIdx}:v]${geq},setsar=1[${bgLabel}]`);
      inputIdx++;

    } else {
      // Couleur solide (défaut)
      const rawHex = (bg.color || '#000000').replace('#', '');
      inputs.push('-f', 'lavfi', '-i', `color=c=0x${rawHex}:s=${W}x${H}:d=${duration}:r=${FPS}`);
      filters.push(`[${inputIdx}:v]setsar=1[${bgLabel}]`);
      inputIdx++;
    }

    // ── Overlay d'assombrissement sur image (pour lisibilité du texte) ──
    if ((bg.type === 'image' || bg.type === 'unsplash') && bg._localPath) {
      const dimOpacity = bg.dimOpacity ?? 0.45;
      if (dimOpacity > 0) {
        const dimLabel = `dim${si}`;
        inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${duration}:r=${FPS}`);
        filters.push(
          `[${inputIdx}:v]setsar=1[dimraw${si}]`,
          `[${bgLabel}][dimraw${si}]blend=all_mode=overlay:all_opacity=${dimOpacity}[${dimLabel}]`
        );
        inputIdx++;
        bgLabel = dimLabel;
      }
    }

    // ── Elements visuels ─────────────────────────────────────
    let prevLabel = bgLabel;

    for (let ei = 0; ei < elements.length; ei++) {
      const el        = elements[ei];
      const nextLabel = `sc${si}_el${ei}`;

      if (el.type === 'text') {
        const bold     = el.style?.bold || false;
        const fontFile = bold ? fontBold : font;
        const fontSize = resolveFontSize(el.style?.fontsize || el.style?.fontSize, H, refH);
        const color    = (el.style?.fontcolor || el.style?.color || '#ffffff').replace('#','');
        const shadow   = el.style?.shadow ? `shadowcolor=black@0.85:shadowx=${Math.max(2,Math.round(fontSize*0.04))}:shadowy=${Math.max(2,Math.round(fontSize*0.04))}:` : '';
        const fontParam = fontFile ? `fontfile='${fontFile}':` : '';

        const x = resolvePos(el.x, 'x', W, H, refW, refH);
        const y = resolvePos(el.y, 'y', W, H, refW, refH);

        // ── ANIMATIONS RÉELLES ─────────────────────────────
        const anim = el.animation || {};
        let enableExpr = '1';
        let alphaExpr  = '1';
        let xExpr      = x;
        let yExpr      = y;

        switch (anim.type) {
          case 'fade_in': {
            const start = anim.start || 0;
            const dur   = anim.duration || 0.6;
            // alpha de 0 à 1 pendant `dur` secondes à partir de `start`
            alphaExpr  = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          case 'fade_out': {
            const start = anim.start || (scene.duration - 0.6);
            const dur   = anim.duration || 0.6;
            alphaExpr  = `if(lt(t,${start}),1,if(lt(t,${start}+${dur}),1-(t-${start})/${dur},0))`;
            enableExpr = `lte(t,${start}+${dur})`;
            break;
          }
          case 'slide_left': {
            const start = anim.start || 0;
            const dur   = anim.duration || 0.5;
            // Slide depuis droite vers position cible
            const progress = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            xExpr = `${x}+w*(1-${progress})`;
            alphaExpr = `if(lt(t,${start}),0,1)`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          case 'slide_right': {
            const start = anim.start || 0;
            const dur   = anim.duration || 0.5;
            const progress = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            xExpr = `${x}-w*(1-${progress})`;
            alphaExpr = `if(lt(t,${start}),0,1)`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          case 'slide_up': {
            const start = anim.start || 0;
            const dur   = anim.duration || 0.5;
            const progress = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            yExpr = `${y}+h*0.15*(1-${progress})`;
            alphaExpr = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          case 'slide_down': {
            const start = anim.start || 0;
            const dur   = anim.duration || 0.5;
            const progress = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            yExpr = `${y}-h*0.15*(1-${progress})`;
            alphaExpr = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          case 'appear': {
            const start = anim.start || 0;
            enableExpr = `gte(t,${start})`;
            alphaExpr  = `if(lt(t,${start}),0,1)`;
            break;
          }
          case 'typewriter': {
            // Simulé par enable progressif — FFmpeg ne supporte pas le vrai typewriter
            // On utilise plusieurs éléments à la place, ou fade_in avec courte durée
            const start = anim.start || 0;
            const dur   = anim.duration || 0.8;
            alphaExpr  = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          case 'pulse': {
            // Oscillation alpha 0.6–1.0
            const speed = anim.speed || 2;
            alphaExpr  = `0.7+0.3*sin(t*${speed}*PI)`;
            break;
          }
          case 'bounce': {
            const start = anim.start || 0;
            const dur   = anim.duration || 0.7;
            const progress = `if(lt(t,${start}),0,if(lt(t,${start}+${dur}),(t-${start})/${dur},1))`;
            // Bounce: overshoot puis settle
            yExpr = `${y}-h*0.05*abs(sin(${progress}*PI*2.5))*exp(-${progress}*3)*(1-${progress})`;
            alphaExpr = `if(lt(t,${start}),0,if(lt(t,${start}+0.1),(t-${start})/0.1,1))`;
            enableExpr = `gte(t,${start})`;
            break;
          }
          default:
            break;
        }

        const textEscaped = escapeDrawtext(el.content || el.text || '');
        const dt = `drawtext=${fontParam}text='${textEscaped}':fontsize=${fontSize}:fontcolor=${color}@${alphaExpr}:x=${xExpr}:y=${yExpr}:${shadow}enable='${enableExpr}'`;
        filters.push(`[${prevLabel}]${dt}[${nextLabel}]`);
        prevLabel = nextLabel;

      } else if (el.type === 'rect' || el.type === 'box') {
        const bx = `(w*${typeof el.x === 'number' && el.x <= 1 ? el.x : (el.x / (refW||1080)).toFixed(4)})`;
        const by = `(h*${typeof el.y === 'number' && el.y <= 1 ? el.y : (el.y / (refH||1920)).toFixed(4)})`;
        const bw = resolveDim(el.width,  'w', W, H, refW, refH);
        const bh = resolveDim(el.height, 'h', W, H, refW, refH);
        const bc = `0x${(el.color || '#ffffff').replace('#', '')}`;
        const alpha = el.opacity ?? 0.5;
        filters.push(`[${prevLabel}]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${bc}@${alpha}:t=fill[${nextLabel}]`);
        prevLabel = nextLabel;

      } else if (el.type === 'line') {
        const lx1 = `(w*${typeof el.x1 === 'number' && el.x1 <= 1 ? el.x1 : ((el.x1||0) / (refW||1080)).toFixed(4)})`;
        const ly1 = `(h*${typeof el.y1 === 'number' && el.y1 <= 1 ? el.y1 : ((el.y1||0) / (refH||1920)).toFixed(4)})`;
        const lx2 = `(w*${typeof el.x2 === 'number' && el.x2 <= 1 ? el.x2 : ((el.x2||W) / (refW||1080)).toFixed(4)})`;
        const lineW = `(${lx2}-${lx1})`;
        const lh = Math.max(2, Math.round(H * 0.003));
        const lc = `0x${(el.color || '#f5a623').replace('#', '')}`;
        filters.push(`[${prevLabel}]drawbox=x=${lx1}:y=${ly1}:w=${lineW}:h=${lh}:color=${lc}:t=fill[${nextLabel}]`);
        prevLabel = nextLabel;
      }
    }

    filters.push(`[${prevLabel}]null[scene${si}]`);
    sceneLabels.push(`scene${si}`);
  }

  // ── Transitions & concat ──────────────────────────────────────
  let finalLabel;
  if (sceneLabels.length === 1) {
    finalLabel = sceneLabels[0];
  } else {
    const transitions = sceneGraph.transitions || [];
    const transMap = {};
    for (const t of transitions) {
      const fromIdx = scenes.findIndex(s => s.id === t.from);
      if (fromIdx >= 0) transMap[fromIdx] = t;
    }
    let current = sceneLabels[0];
    let cumul   = scenes[0]?.duration || 3;
    for (let i = 1; i < sceneLabels.length; i++) {
      const trans    = transMap[i - 1];
      const tDur     = Math.min(trans?.duration || 0.5, Math.min(scenes[i-1]?.duration||3, scenes[i]?.duration||3) - 0.1);
      const tType    = XFADE_TRANSITIONS.includes(trans?.type) ? trans.type : 'fade';
      const offset   = Math.max(0.01, cumul - tDur);
      const xfLabel  = `xf${i}`;
      filters.push(`[${current}][${sceneLabels[i]}]xfade=transition=${tType}:duration=${tDur}:offset=${offset}[${xfLabel}]`);
      current = xfLabel;
      cumul  += (scenes[i]?.duration || 3) - tDur;
    }
    finalLabel = current;
  }

  // ── Audio ────────────────────────────────────────────────────
  const audio = sceneGraph.audio || { type: 'none' };
  let hasAudio = false;
  if (audio.type === 'file' && audio.path && fs.existsSync(audio.path)) {
    inputs.push('-i', audio.path);
    hasAudio = true;
    inputIdx++;
  }
  const silentIdx = inputIdx;
  if (!hasAudio) inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  const filterStr   = filters.join('; ');
  const audioMapIdx = hasAudio ? inputIdx - 1 : silentIdx;

  const cmd = [
    ...inputs,
    '-filter_complex', filterStr,
    '-map', `[${finalLabel}]`,
    '-map', `${audioMapIdx}:a`,
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',   // ← Render.com free: CPU minimal
    '-crf', '26',
    '-threads', '1',          // ← 1 thread = stable sur 0.1 CPU
    '-x264-params', 'threads=1:lookahead-threads=1',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    '-y',
  ];

  return { cmd, tmpFiles };
}

// ─────────────────────────────────────────────────────────────────
//  POST /api/render/sync — Render direct (mode Render.com)
// ─────────────────────────────────────────────────────────────────
app.post('/api/render/sync', async (req, res) => {
  const jobId  = uuidv4();
  const tmpFile = path.join(os.tmpdir(), `intentfilm_${jobId}.mp4`);
  let tmpFiles  = [];

  try {
    let sg = req.body;
    if (typeof sg === 'string') sg = JSON.parse(sg);
    if (sg.json) sg = typeof sg.json === 'string' ? JSON.parse(sg.json) : sg.json;
    if (!sg.scenes || !Array.isArray(sg.scenes))
      return res.status(400).json({ error: '"scenes" requis (tableau)' });

    console.log(`[sync:${jobId.slice(0,8)}] Format: ${sg.format} — ${sg.scenes.length} scène(s)`);

    const { cmd, tmpFiles: tf } = await buildFfmpegCmd(jobId, sg);
    tmpFiles = tf;

    const cmdFinal = [...cmd, tmpFile];
    console.log(`[sync:${jobId.slice(0,8)}] CMD: ${FFMPEG_BIN} ${cmdFinal.slice(0, 10).join(' ')} ...`);

    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, cmdFinal, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errOut = '';
      proc.stderr.on('data', d => { errOut += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else {
          console.error(`[sync:${jobId.slice(0,8)}] FFmpeg erreur:\n${errOut.slice(-2000)}`);
          reject(new Error(`FFmpeg code ${code}:\n${errOut.slice(-600)}`));
        }
      });
      proc.on('error', e => reject(new Error(`FFmpeg introuvable: ${e.message}`)));
    });

    const stat = fs.statSync(tmpFile);
    console.log(`[sync:${jobId.slice(0,8)}] OK → ${(stat.size/1024/1024).toFixed(2)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="intentfilm.mp4"');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('close', () => {
      fs.unlink(tmpFile, () => {});
      for (const f of tmpFiles) fs.unlink(f, () => {});
    });

  } catch (e) {
    fs.unlink(tmpFile, () => {});
    for (const f of tmpFiles) fs.unlink(f, () => {});
    console.error(`[sync:${jobId.slice(0,8)}] ERREUR:`, e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  EXEMPLE SCENE GRAPH v2 — positions en ratio (0–1)
//  COMPATIBLE avec toutes les résolutions
// ─────────────────────────────────────────────────────────────────
const EXAMPLE_SCENE_GRAPH = {
  "title": "INTENTFILM v2 — Demo",
  "format": "tiktok_vertical",
  "fps": 30,
  // Positions X/Y en ratio 0.0–1.0 (ratio de W ou H)
  // fontSize en ratio de H (ex: 0.07 = 7% de la hauteur)
  // OU en pixels absolus dans le référentiel referenceWidth/Height
  "scenes": [
    {
      "id": "intro",
      "duration": 3.5,
      "background": { "type": "gradient", "color1": "#050510", "color2": "#0d0030" },
      "elements": [
        {
          "type": "rect",
          "x": 0, "y": 0.36,
          "width": 1, "height": 0.28,
          "color": "#f5a623", "opacity": 0.08
        },
        {
          "type": "text",
          "content": "INTENTFILM",
          "x": "(w-tw)/2",
          "y": "h*0.40",
          "style": { "fontsize": 0.11, "fontcolor": "#f5a623", "bold": true, "shadow": true },
          "animation": { "type": "slide_up", "start": 0.2, "duration": 0.6 }
        },
        {
          "type": "text",
          "content": "Tu décris. Le moteur génère.",
          "x": "(w-tw)/2",
          "y": "h*0.53",
          "style": { "fontsize": 0.038, "fontcolor": "#cccccc" },
          "animation": { "type": "fade_in", "start": 0.8, "duration": 0.7 }
        },
        {
          "type": "line",
          "x1": 0.12, "y1": 0.62, "x2": 0.88, "y2": 0.62,
          "color": "#f5a623"
        },
        {
          "type": "text",
          "content": "v2.0 — Cinéma IA",
          "x": "(w-tw)/2",
          "y": "h*0.67",
          "style": { "fontsize": 0.028, "fontcolor": "#666666" },
          "animation": { "type": "fade_in", "start": 1.5, "duration": 0.5 }
        }
      ]
    },
    {
      "id": "hook",
      "duration": 4,
      "background": {
        "type": "unsplash",
        "query": "cinematic city night lights",
        "dimOpacity": 0.55
      },
      "elements": [
        {
          "type": "rect",
          "x": 0, "y": 0.28,
          "width": 1, "height": 0.44,
          "color": "#000000", "opacity": 0.5
        },
        {
          "type": "text",
          "content": "🎬 100 000 VUES",
          "x": "(w-tw)/2",
          "y": "h*0.33",
          "style": { "fontsize": 0.09, "fontcolor": "#ffffff", "bold": true, "shadow": true },
          "animation": { "type": "slide_left", "start": 0.1, "duration": 0.5 }
        },
        {
          "type": "text",
          "content": "en 24 heures",
          "x": "(w-tw)/2",
          "y": "h*0.44",
          "style": { "fontsize": 0.055, "fontcolor": "#f5a623", "bold": true },
          "animation": { "type": "fade_in", "start": 0.5, "duration": 0.5 }
        },
        {
          "type": "text",
          "content": "avec la bonne vidéo.",
          "x": "(w-tw)/2",
          "y": "h*0.55",
          "style": { "fontsize": 0.036, "fontcolor": "#aaaaaa" },
          "animation": { "type": "fade_in", "start": 1.2, "duration": 0.6 }
        }
      ]
    },
    {
      "id": "cta",
      "duration": 3.5,
      "background": { "type": "gradient", "color1": "#1a0000", "color2": "#3d0010" },
      "elements": [
        {
          "type": "text",
          "content": "Génère ta vidéo",
          "x": "(w-tw)/2",
          "y": "h*0.36",
          "style": { "fontsize": 0.072, "fontcolor": "#ffffff", "bold": true, "shadow": true },
          "animation": { "type": "slide_up", "start": 0.1, "duration": 0.5 }
        },
        {
          "type": "text",
          "content": "GRATUITEMENT",
          "x": "(w-tw)/2",
          "y": "h*0.47",
          "style": { "fontsize": 0.085, "fontcolor": "#ff4444", "bold": true },
          "animation": { "type": "bounce", "start": 0.4, "duration": 0.7 }
        },
        {
          "type": "rect",
          "x": 0.1, "y": 0.58,
          "width": 0.8, "height": 0.07,
          "color": "#f5a623", "opacity": 0.15
        },
        {
          "type": "text",
          "content": "intentfilm.com",
          "x": "(w-tw)/2",
          "y": "h*0.60",
          "style": { "fontsize": 0.042, "fontcolor": "#f5a623", "bold": true },
          "animation": { "type": "pulse" }
        }
      ]
    }
  ],
  "transitions": [
    { "from": "intro", "to": "hook", "type": "fadeblack", "duration": 0.5 },
    { "from": "hook",  "to": "cta",  "type": "wipeup",    "duration": 0.6 }
  ],
  "audio": { "type": "none" }
};

// ─────────────────────────────────────────────────────────────────
//  AUTRES ROUTES API
// ─────────────────────────────────────────────────────────────────

app.post('/api/render', (req, res) => {
  try {
    let sg = req.body;
    if (typeof sg === 'string') sg = JSON.parse(sg);
    if (sg.json) sg = typeof sg.json === 'string' ? JSON.parse(sg.json) : sg.json;
    if (!sg.scenes || !Array.isArray(sg.scenes))
      return res.status(400).json({ error: '"scenes" requis' });
    const jobId = createJob(sg, 'json');
    setImmediate(() => processJob(jobId));
    res.json({ jobId, status: 'queued', statusUrl: `${BASE_URL}/api/status/${jobId}` });
  } catch (e) {
    res.status(400).json({ error: `JSON invalide: ${e.message}` });
  }
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  res.json({ id: job.id, status: job.status, progress: job.progress,
    downloadUrl: job.downloadUrl, error: job.error });
});

app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.status !== 'done') return res.status(202).json({ error: 'Pas encore prêt' });
  if (!fs.existsSync(job.outputFile)) return res.status(404).json({ error: 'Fichier introuvable' });
  const stat = fs.statSync(job.outputFile);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="intentfilm_${job.id.slice(0,8)}.mp4"`);
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(job.outputFile).pipe(res);
});

app.get('/api/example', (req, res) => res.json(EXAMPLE_SCENE_GRAPH));
app.get('/api/formats', (req, res) => res.json(FORMATS));
app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()].map(j => ({
    id: j.id, status: j.status, progress: j.progress,
    source: j.source, createdAt: j.createdAt,
  }));
  res.json(list);
});
app.get('/health', (req, res) => res.json({ ok: true, version: '2.0.0',
  unsplash: !!UNSPLASH_KEY, gemini: !!GEMINI_KEY }));

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  updateJob(jobId, { status: 'rendering', progress: 5 });
  const tmpFile = path.join(os.tmpdir(), `intentfilm_${jobId}.mp4`);
  try {
    const { cmd } = await buildFfmpegCmd(jobId, job.sceneGraph);
    const cmdFinal = [...cmd, tmpFile];
    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, cmdFinal, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stderr.on('data', d => {
        const m = d.toString().match(/time=(\d+):(\d+):(\d+)/);
        if (m) {
          const secs = +m[1]*3600 + +m[2]*60 + +m[3];
          const total = (job.sceneGraph.scenes||[]).reduce((a,s)=>a+(s.duration||3),0);
          updateJob(jobId, { progress: Math.min(95, Math.round(secs/total*100)) });
        }
      });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg code ${code}`)));
      proc.on('error', e => reject(e));
    });
    const outputFile = path.join(RENDER_DIR, `intentfilm_${jobId}.mp4`);
    fs.renameSync(tmpFile, outputFile);
    updateJob(jobId, { status: 'done', progress: 100, outputFile,
      downloadUrl: `/api/download/${jobId}` });
  } catch (e) {
    fs.unlink(tmpFile, () => {});
    updateJob(jobId, { status: 'error', error: e.message });
  }
}

// ── IA Generate (Gemini / OpenRouter) ─────────────────────────────
app.post('/api/ai/generate', async (req, res) => {
  const { prompt = '', format = 'tiktok_vertical' } = req.body;
  const stub = { ...EXAMPLE_SCENE_GRAPH, title: prompt.slice(0,60), format };

  if (OPENROUTER_KEY) {
    try {
      const fetch = (await import('node-fetch')).default;
      const systemPrompt = `Tu es INTENTFILM, un générateur de Scene Graph JSON pour vidéos cinématiques.
RÈGLES STRICTES:
- Réponds UNIQUEMENT avec du JSON valide, AUCUN texte avant ou après
- Positions X/Y en ratio 0.0–1.0 (ex: 0.5 = centre, 0.1 = 10%)
- fontSize en ratio de hauteur 0.0–1.0 (ex: 0.08 = 8% de H)
- "(w-tw)/2" pour centrer horizontalement, "h*0.X" pour positionner verticalement
- Types d'animation: fade_in, fade_out, slide_up, slide_down, slide_left, slide_right, appear, bounce, pulse
- Backgrounds: color, gradient, unsplash (avec champ query en anglais)
- Utilise 3–5 scènes avec transitions cinématiques
- Format attendu: ${format}`;

      const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer': BASE_URL,
        },
        body: JSON.stringify({
          model: 'google/gemini-flash-1.5',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Génère une vidéo: "${prompt}"\n\nExemple de référence:\n${JSON.stringify(EXAMPLE_SCENE_GRAPH, null, 2)}` }
          ],
          max_tokens: 4000,
          temperature: 0.7,
        }),
      });
      const data = await aiRes.json();
      const text = data?.choices?.[0]?.message?.content || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return res.json(parsed);
    } catch (e) {
      console.error('OpenRouter erreur:', e.message);
    }
  }

  if (GEMINI_KEY) {
    try {
      const fetch = (await import('node-fetch')).default;
      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Tu es INTENTFILM. Génère UNIQUEMENT un JSON (sans markdown) pour: "${prompt}". Format: ${format}. Positions en ratio 0–1. fontSize en ratio 0–1. Utilise le format de cet exemple: ${JSON.stringify(EXAMPLE_SCENE_GRAPH)}` }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
          }),
        }
      );
      const gemData = await gemRes.json();
      const text = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.json(parsed);
    } catch (e) {
      console.error('Gemini erreur:', e.message);
    }
  }

  return res.json(stub);
});

// ─────────────────────────────────────────────────────────────────
//  LANDING PAGE
// ─────────────────────────────────────────────────────────────────
const HTML_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>INTENTFILM v2 — Tu décris. Le moteur génère.</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@300;400;600&family=Crimson+Pro:ital,wght@0,300;0,600;1,300&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#f5a623;--gold-dim:#c8821a;--red:#ff3b3b;
  --bg:#080808;--bg2:#0f0f0f;--bg3:#161616;
  --border:#1e1e1e;--text:#e8e8e8;--muted:#666;
  --font-display:'Bebas Neue',sans-serif;
  --font-mono:'IBM Plex Mono',monospace;
  --font-body:'Crimson Pro',Georgia,serif;
}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:18px;line-height:1.6;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");pointer-events:none;z-index:9999;opacity:0.5}

.hero{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 24px;position:relative;background:radial-gradient(ellipse 80% 60% at 50% 0%,#1a0b00 0%,var(--bg) 70%)}
.hero::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent)}
.badge{display:inline-block;border:1px solid var(--gold);color:var(--gold);font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;padding:5px 16px;margin-bottom:32px;text-transform:uppercase}
.hero h1{font-family:var(--font-display);font-size:clamp(80px,18vw,200px);line-height:.88;letter-spacing:.04em;color:#fff;margin-bottom:8px}
.hero h1 span{color:var(--gold)}
.tagline{font-family:var(--font-mono);font-size:clamp(12px,2vw,16px);color:var(--muted);letter-spacing:.08em;margin-bottom:40px}
.hero-cta{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
.btn{font-family:var(--font-mono);font-size:13px;letter-spacing:.12em;text-transform:uppercase;padding:14px 32px;cursor:pointer;border:none;text-decoration:none;display:inline-block;transition:all .2s}
.btn-primary{background:var(--gold);color:#000;font-weight:600}
.btn-primary:hover{background:#fff;color:#000}
.btn-outline{background:transparent;color:var(--gold);border:1px solid var(--gold)}
.btn-outline:hover{background:var(--gold);color:#000}

.stats{display:flex;gap:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);overflow:hidden}
.stat{flex:1;padding:40px 20px;text-align:center;border-right:1px solid var(--border)}
.stat:last-child{border-right:none}
.stat-n{font-family:var(--font-display);font-size:56px;color:var(--gold);display:block}
.stat-l{font-family:var(--font-mono);font-size:12px;color:var(--muted);letter-spacing:.15em;text-transform:uppercase}

section{padding:80px 24px;max-width:1200px;margin:0 auto}
.section-label{font-family:var(--font-mono);font-size:11px;color:var(--gold);letter-spacing:.25em;text-transform:uppercase;margin-bottom:16px}
h2{font-family:var(--font-display);font-size:clamp(40px,7vw,80px);line-height:.92;letter-spacing:.04em;margin-bottom:8px}
.sub{font-family:var(--font-mono);font-size:14px;color:var(--muted);margin-bottom:48px}

/* ── STUDIO ── */
.studio{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--border);border:1px solid var(--border)}
@media(max-width:800px){.studio{grid-template-columns:1fr}}
.studio-panel{background:var(--bg2);padding:28px}
.studio-panel h3{font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)}
.studio-tabs{display:flex;gap:2px;margin-bottom:16px}
.tab{font-family:var(--font-mono);font-size:12px;padding:8px 20px;cursor:pointer;background:var(--bg3);color:var(--muted);border:none;letter-spacing:.1em;text-transform:uppercase;transition:all .15s}
.tab.active{background:var(--gold);color:#000;font-weight:600}
.tab-content{display:none}.tab-content.active{display:block}
textarea{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:11px;padding:16px;resize:vertical;min-height:340px;line-height:1.6;outline:none;transition:border-color .2s}
textarea:focus{border-color:var(--gold-dim)}
input[type=text]{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:14px;padding:14px 16px;outline:none;transition:border-color .2s;margin-bottom:12px}
input[type=text]:focus{border-color:var(--gold-dim)}
.render-actions{display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap}
.select-format{background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px;padding:10px 14px;cursor:pointer;outline:none;flex:1;min-width:160px}
.render-btn{background:var(--gold);color:#000;font-family:var(--font-mono);font-size:12px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;padding:11px 28px;border:none;cursor:pointer;transition:all .15s;white-space:nowrap}
.render-btn:hover{background:#fff}
.render-btn:disabled{background:#333;color:#666;cursor:not-allowed}

.preview-panel{display:flex;flex-direction:column;gap:16px}
.status-box{background:var(--bg);border:1px solid var(--border);padding:16px;font-family:var(--font-mono);font-size:12px;min-height:80px;color:var(--muted)}
.status-done{color:#4ade80}.status-error{color:var(--red)}.status-rendering{color:var(--gold)}
.progress-bar{width:100%;height:3px;background:var(--border);margin-top:8px;overflow:hidden}
.progress-fill{height:100%;background:var(--gold);width:0%;transition:width .5s ease}
.video-container{background:var(--bg);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;min-height:320px}
.video-container video{width:100%;height:100%;object-fit:contain;max-height:500px}
.video-placeholder{display:flex;flex-direction:column;align-items:center;gap:12px;color:#2a2a2a;font-family:var(--font-mono);font-size:12px;letter-spacing:.1em;padding:40px}
.video-placeholder svg{opacity:.3}

/* Info boxes */
.info-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:32px}
.info-card{background:var(--bg2);border:1px solid var(--border);padding:20px}
.info-card h4{font-family:var(--font-mono);font-size:12px;color:var(--gold);margin-bottom:10px;letter-spacing:.1em}
.info-card p{font-family:var(--font-mono);font-size:11px;color:var(--muted);line-height:1.8}
code{font-family:var(--font-mono);font-size:11px;background:var(--bg3);padding:2px 6px;color:var(--gold);border:1px solid var(--border)}

/* Plans */
.plans{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:2px;background:var(--border);border:1px solid var(--border);margin-top:40px}
.plan{background:var(--bg2);padding:40px 32px;position:relative}
.plan.featured{background:#0d0800}
.plan-badge{position:absolute;top:20px;right:20px;background:var(--gold);color:#000;font-family:var(--font-mono);font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;padding:4px 10px}
.plan-name{font-family:var(--font-display);font-size:40px;letter-spacing:.06em;margin-bottom:4px}
.plan-price{font-family:var(--font-mono);font-size:13px;color:var(--muted);margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--border)}
.plan-price strong{font-size:36px;color:var(--text);font-family:var(--font-display);letter-spacing:.04em}
.plan-features{list-style:none;margin-bottom:32px}
.plan-features li{font-family:var(--font-mono);font-size:12px;color:var(--muted);padding:8px 0;border-bottom:1px solid var(--border);letter-spacing:.06em}
.plan-features li::before{content:'→  ';color:var(--gold)}

.contact-strip{background:var(--bg2);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:60px 24px;text-align:center}
.wa-btn{display:inline-flex;align-items:center;gap:12px;background:#25d366;color:#000;font-family:var(--font-mono);font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;padding:16px 36px;text-decoration:none;transition:all .2s;margin-top:24px}
.wa-btn:hover{background:#fff}
footer{padding:40px 24px;text-align:center;border-top:1px solid var(--border);font-family:var(--font-mono);font-size:11px;color:#333;letter-spacing:.12em}

@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulsing{animation:pulse 1.5s ease-in-out infinite}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border)}
::-webkit-scrollbar-thumb:hover{background:var(--gold-dim)}
@media(max-width:600px){.stats{flex-direction:column}.stat{border-right:none;border-bottom:1px solid var(--border)}.studio-panel{padding:16px}section{padding:60px 16px}}
</style>
</head>
<body>

<header class="hero">
  <div class="badge">Moteur de génération vidéo IA · v2.0</div>
  <h1>INTENT<span>FILM</span></h1>
  <p class="tagline">TU DÉCRIS &nbsp;·&nbsp; LE MOTEUR GÉNÈRE &nbsp;·&nbsp; TU PUBLIES</p>
  <p style="font-family:var(--font-mono);font-size:12px;color:var(--gold);margin-bottom:32px;letter-spacing:.15em">
    ✅ Positions corrigées &nbsp;·&nbsp; ✅ Animations réelles &nbsp;·&nbsp; ✅ Unsplash &nbsp;·&nbsp; ✅ Green Screen
  </p>
  <div class="hero-cta">
    <a href="#studio" class="btn btn-primary">→ Générer maintenant</a>
    <a href="#plans" class="btn btn-outline">Voir les plans</a>
  </div>
</header>

<div class="stats">
  <div class="stat"><span class="stat-n">6+</span><span class="stat-l">Formats vidéo</span></div>
  <div class="stat"><span class="stat-n">8+</span><span class="stat-l">Animations</span></div>
  <div class="stat"><span class="stat-n">∞</span><span class="stat-l">Photos Unsplash</span></div>
  <div class="stat"><span class="stat-n">🟢</span><span class="stat-l">Green Screen</span></div>
</div>

<section id="studio">
  <div class="section-label">Studio de génération</div>
  <h2>GÉNÈRE<br>TA VIDÉO</h2>
  <p class="sub">Positions en ratio · Animations fluides · Fonds Unsplash</p>

  <div class="studio">
    <div class="studio-panel">
      <h3>Source</h3>
      <div class="studio-tabs">
        <button class="tab active" onclick="switchTab('json')">JSON</button>
        <button class="tab" onclick="switchTab('text')">IA Texte</button>
      </div>

      <div class="tab-content active" id="tab-json">
        <textarea id="json-input" placeholder="Colle ton scene graph JSON ici...&#10;&#10;Conseil v2: positions X/Y en ratio 0.0–1.0&#10;fontSize en ratio de H (ex: 0.08 = 8%)&#10;Animations: slide_up, fade_in, bounce, pulse..."></textarea>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="loadExample()" style="font-size:11px;padding:8px 16px">▼ Exemple v2</button>
          <button class="btn btn-outline" onclick="formatJSON()" style="font-size:11px;padding:8px 16px">{ } Formater</button>
          <button class="btn btn-outline" onclick="loadGreenscreen()" style="font-size:11px;padding:8px 16px">🟢 Green Screen</button>
        </div>
      </div>

      <div class="tab-content" id="tab-text">
        <p style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-bottom:12px">
          ⚡ L'IA génère le Scene Graph automatiquement (nécessite OPENROUTER_KEY ou GEMINI_KEY)
        </p>
        <input type="text" id="text-prompt" placeholder='Ex: "Vidéo TikTok 15s motivation sportive, fond sombre, textes dynamiques, photos action"'>
        <textarea id="text-context" placeholder="Style additionnel (optionnel)..." style="min-height:120px"></textarea>
      </div>

      <div class="render-actions">
        <select class="select-format" id="format-select">
          <option value="tiktok_vertical">TikTok / Reels (9:16)</option>
          <option value="youtube_landscape">YouTube paysage (16:9)</option>
          <option value="instagram_square">Instagram carré (1:1)</option>
          <option value="youtube_shorts">YouTube Shorts (9:16)</option>
          <option value="twitter_landscape">X / Twitter (16:9)</option>
          <option value="greenscreen">Green Screen (16:9)</option>
        </select>
        <button class="render-btn" id="render-btn" onclick="startRender()">▶ GÉNÉRER</button>
      </div>
    </div>

    <div class="studio-panel preview-panel">
      <h3>Aperçu & Résultat</h3>
      <div class="status-box" id="status-box">
        <span style="color:#2a2a2a">En attente d'un job…</span>
        <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      </div>
      <div class="video-container" id="video-container">
        <div class="video-placeholder">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polygon points="5,3 19,12 5,21"/></svg>
          <span>La vidéo apparaît ici</span>
        </div>
      </div>
      <div id="download-area" style="display:none;margin-top:8px">
        <a id="download-link" class="btn btn-primary" style="width:100%;text-align:center;display:block">↓ TÉLÉCHARGER MP4</a>
      </div>
    </div>
  </div>
</section>

<!-- GUIDE v2 -->
<div style="max-width:1200px;margin:0 auto;padding:0 24px 80px">
  <div style="background:var(--bg2);border:1px solid var(--border);padding:40px">
    <div class="section-label">Guide v2 — Positions & Animations</div>
    <h2 style="font-size:36px">NOUVEAU SYSTÈME</h2>
    <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:12px 0 24px">
      ⚠️ BREAKING CHANGE: positions en ratio 0–1, fontSize en ratio de H
    </p>
    <div class="info-grid">
      <div class="info-card">
        <h4>Positions X / Y</h4>
        <p>
          Ratio <code>0.0–1.0</code> (recommandé):<br>
          <code>x: 0.5</code> = 50% de la largeur<br>
          <code>y: 0.3</code> = 30% de la hauteur<br><br>
          FFmpeg natif:<br>
          <code>"(w-tw)/2"</code> = centré H<br>
          <code>"h*0.45"</code> = 45% de H<br><br>
          Ancien px (1080×1920):<br>
          Convertir → diviser par 1080/1920
        </p>
      </div>
      <div class="info-card">
        <h4>fontSize</h4>
        <p>
          Ratio de H <code>0.0–1.0</code>:<br>
          <code>0.06</code> = 6% → ~58px sur 960H<br>
          <code>0.08</code> = 8% → ~77px sur 960H<br>
          <code>0.12</code> = 12% → ~115px sur 960H<br><br>
          Ou pixels directs si &lt; H/2:<br>
          <code>72</code> → 72px bruts
        </p>
      </div>
      <div class="info-card">
        <h4>Animations</h4>
        <p>
          <code>fade_in</code> — fondu entrant<br>
          <code>fade_out</code> — fondu sortant<br>
          <code>slide_up</code> — glisse du bas<br>
          <code>slide_down</code> — glisse du haut<br>
          <code>slide_left</code> — depuis droite<br>
          <code>slide_right</code> — depuis gauche<br>
          <code>bounce</code> — rebond cinéma<br>
          <code>pulse</code> — pulsation<br>
          <code>appear</code> — apparition nette
        </p>
      </div>
      <div class="info-card">
        <h4>Backgrounds</h4>
        <p>
          <code>color</code> → couleur hex<br>
          <code>gradient</code> → color1 + color2<br>
          <code>unsplash</code> → query (en anglais)<br>
          &nbsp;&nbsp;+ <code>dimOpacity: 0.5</code><br>
          <code>image</code> → path local<br>
          <code>transparent</code> → fond vert<br><br>
          Format <code>greenscreen</code>:<br>
          → fond vert pur sur toutes scènes
        </p>
      </div>
    </div>
  </div>
</div>

<section id="plans">
  <div class="section-label">Abonnements</div>
  <h2>PLANS &<br>TARIFS</h2>
  <p class="sub">Commence gratuitement · Monte en puissance</p>
  <div class="plans">
    <div class="plan">
      <div class="plan-name">FREE</div>
      <div class="plan-price"><strong>0€</strong> / mois</div>
      <ul class="plan-features">
        <li>1 vidéo par jour</li><li>720p maximum</li><li>Watermark INTENTFILM</li>
        <li>Formats TikTok & Shorts</li><li>Animations de base</li><li>Export MP4</li>
      </ul>
      <a href="#studio" class="btn btn-outline" style="width:100%;text-align:center">Commencer</a>
    </div>
    <div class="plan featured">
      <div class="plan-badge">Populaire</div>
      <div class="plan-name">PRO</div>
      <div class="plan-price"><strong>9€</strong> / mois</div>
      <ul class="plan-features">
        <li>50 vidéos par jour</li><li>1080p Full HD</li><li>Sans watermark</li>
        <li>Tous les formats</li><li>Unsplash intégré</li><li>8+ animations</li>
        <li>Green Screen</li><li>Génération IA via texte</li><li>Support WhatsApp</li>
      </ul>
      <a href="https://wa.me/240555445514" class="btn btn-primary" style="width:100%;text-align:center" target="_blank">Souscrire →</a>
    </div>
    <div class="plan">
      <div class="plan-name">STUDIO</div>
      <div class="plan-price"><strong>29€</strong> / mois</div>
      <ul class="plan-features">
        <li>Vidéos illimitées</li><li>4K (bientôt)</li><li>API accès direct</li>
        <li>Lipsync automatique</li><li>Avatar IA</li><li>Multi-comptes</li>
        <li>Self-host option</li><li>Support prioritaire</li>
      </ul>
      <a href="https://wa.me/240555445514" class="btn btn-outline" style="width:100%;text-align:center" target="_blank">Contacter →</a>
    </div>
  </div>
</section>

<div class="contact-strip" id="contact">
  <div class="section-label">Support & Ventes</div>
  <h2 style="font-family:var(--font-display);font-size:clamp(36px,6vw,70px)">UNE QUESTION ?</h2>
  <p style="font-family:var(--font-mono);font-size:14px;color:var(--muted);margin-top:8px">On répond sous 2h · En français · 7j/7</p>
  <a href="https://wa.me/240555445514" class="wa-btn" target="_blank">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="#000"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
    WhatsApp : +240 555 445 514
  </a>
</div>

<footer>
  <p style="letter-spacing:.2em;font-size:13px;margin-bottom:12px;color:#444">INTENTFILM v2.0</p>
  <p>© 2025 INTENTFILM · Tu décris. Le moteur génère. · Tous droits réservés</p>
  <p style="margin-top:8px">
    <a href="#studio" style="color:var(--gold);text-decoration:none;margin:0 12px">STUDIO</a>
    <a href="#plans" style="color:var(--muted);text-decoration:none;margin:0 12px">PLANS</a>
    <a href="/api/example" style="color:var(--muted);text-decoration:none;margin:0 12px" target="_blank">API JSON</a>
    <a href="https://wa.me/240555445514" style="color:var(--muted);text-decoration:none;margin:0 12px" target="_blank">CONTACT</a>
  </p>
</footer>

<script>
const EXAMPLE_JSON = ${JSON.stringify(EXAMPLE_SCENE_GRAPH, null, 2)};

const GREENSCREEN_EXAMPLE = {
  "title": "Green Screen Test",
  "format": "greenscreen",
  "fps": 30,
  "scenes": [{
    "id": "gs1",
    "duration": 5,
    "background": { "type": "transparent" },
    "elements": [
      { "type": "text", "content": "TITRE PRINCIPAL", "x": "(w-tw)/2", "y": "h*0.35",
        "style": { "fontsize": 0.1, "fontcolor": "#ffffff", "bold": true, "shadow": true },
        "animation": { "type": "slide_up", "start": 0.2, "duration": 0.6 } },
      { "type": "text", "content": "Sous-titre ici", "x": "(w-tw)/2", "y": "h*0.5",
        "style": { "fontsize": 0.05, "fontcolor": "#f5a623" },
        "animation": { "type": "fade_in", "start": 0.8, "duration": 0.5 } }
    ]
  }],
  "transitions": [],
  "audio": { "type": "none" }
};

let currentTab = 'json';
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', (i===0&&tab==='json')||(i===1&&tab==='text')));
  document.getElementById('tab-json').classList.toggle('active', tab==='json');
  document.getElementById('tab-text').classList.toggle('active', tab==='text');
}
function loadExample() {
  document.getElementById('json-input').value = JSON.stringify(EXAMPLE_JSON, null, 2);
  switchTab('json');
}
function loadGreenscreen() {
  document.getElementById('json-input').value = JSON.stringify(GREENSCREEN_EXAMPLE, null, 2);
  document.getElementById('format-select').value = 'greenscreen';
  switchTab('json');
}
function formatJSON() {
  try {
    const val = document.getElementById('json-input').value;
    document.getElementById('json-input').value = JSON.stringify(JSON.parse(val), null, 2);
  } catch(e) { showStatus('error', 'JSON invalide: ' + e.message, 0); }
}

function showStatus(type, msg, progress) {
  const box = document.getElementById('status-box');
  const cls = type==='done' ? 'status-done' : type==='error' ? 'status-error' : 'status-rendering';
  box.innerHTML = '<span class="'+cls+' '+(type==='rendering'?'pulsing':'')+'">'+msg+'</span><div class="progress-bar"><div class="progress-fill" style="width:'+progress+'%"></div></div>';
}

async function startRender() {
  const btn = document.getElementById('render-btn');
  btn.disabled = true; btn.textContent = '⏳ EN COURS…';
  document.getElementById('download-area').style.display = 'none';
  document.getElementById('video-container').innerHTML = '<div class="video-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polygon points="5,3 19,12 5,21"/></svg><span class="pulsing">Génération en cours…</span></div>';

  try {
    let payload;
    if (currentTab === 'json') {
      const raw = document.getElementById('json-input').value.trim();
      if (!raw) throw new Error('Colle un JSON ou charge un exemple');
      payload = JSON.parse(raw);
    } else {
      const prompt = document.getElementById('text-prompt').value.trim();
      if (!prompt) throw new Error('Décris ta vidéo');
      showStatus('rendering', '🤖 Génération IA du Scene Graph…', 10);
      const aiRes = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, format: document.getElementById('format-select').value })
      });
      if (!aiRes.ok) throw new Error('IA non configurée (ajoute OPENROUTER_KEY ou GEMINI_KEY)');
      payload = await aiRes.json();
    }

    payload.format = document.getElementById('format-select').value || payload.format || 'tiktok_vertical';
    showStatus('rendering', '⚙️ Render en cours… (10–45s selon la complexité)', 15);

    const res = await fetch('/api/render/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erreur serveur' }));
      throw new Error(err.error || 'Erreur serveur');
    }

    showStatus('rendering', '⬇️ Réception…', 85);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);

    showStatus('done', '✓ Vidéo prête !', 100);
    const fmt = payload.format || 'tiktok_vertical';
    const isPortrait = fmt.includes('vertical') || fmt.includes('story') || fmt.includes('short');
    document.getElementById('video-container').innerHTML =
      '<video controls autoplay loop src="'+url+'" style="width:100%;height:100%;object-fit:contain;max-height:500px"></video>';
    const dl = document.getElementById('download-area');
    document.getElementById('download-link').href = url;
    document.getElementById('download-link').download = 'intentfilm_'+fmt+'.mp4';
    dl.style.display = 'block';
    btn.disabled = false; btn.textContent = '▶ GÉNÉRER';

  } catch(e) {
    showStatus('error', '✗ ' + e.message, 0);
    btn.disabled = false; btn.textContent = '▶ GÉNÉRER';
  }
}

window.addEventListener('load', () => {
  const ta = document.getElementById('json-input');
  if (!ta.value) ta.value = JSON.stringify(EXAMPLE_JSON, null, 2);
});
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML_PAGE));

// ─────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  ██╗███╗   ██╗████████╗███████╗███╗   ██╗████████╗███████╗██╗██╗     ███╗   ███╗');
  console.log('  ██║████╗  ██║╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝██╔════╝██║██║     ████╗ ████║');
  console.log(`\n  🎬 INTENTFILM v2.0 — http://localhost:${PORT}`);
  console.log(`  📐 Positions: ratio 0–1 + FFmpeg natif`);
  console.log(`  🎭 Animations: fade_in/out, slide_*, bounce, pulse`);
  console.log(`  🖼️  Unsplash: ${UNSPLASH_KEY ? '✅' : '⚠️  UNSPLASH_ACCESS_KEY manquante'}`);
  console.log(`  🟢 Green Screen: ✅`);
  console.log(`  🤖 IA: ${OPENROUTER_KEY ? '✅ OpenRouter' : GEMINI_KEY ? '✅ Gemini' : '⚠️  non configuré'}`);
  console.log(`  ⚡ Mode: ultrafast · 1 thread · Render.com free tier OK\n`);
});

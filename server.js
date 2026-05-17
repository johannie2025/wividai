// ═══════════════════════════════════════════════════════════════
//  INTENTFILM  —  Core Render Engine  v1.0 MVP
//  Stack: Node.js + Express + FFmpeg (no Puppeteer for MVP)
//  Tu décris une intention. Le moteur génère le film.
// ═══════════════════════════════════════════════════════════════

'use strict';

const express  = require('express');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

// ── App ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── Config ───────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const BASE_URL     = process.env.BASE_URL || `http://localhost:${PORT}`;
const RENDER_DIR   = path.join(process.cwd(), 'renders');
const FFMPEG_BIN   = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN  = process.env.FFPROBE_PATH || 'ffprobe';

// AI Keys (optionnel — pour les fonctionnalités IA futures)
const GEMINI_KEY      = process.env.GEMINI_API_KEY     || '';
const OPENROUTER_KEY  = process.env.OPENROUTER_API_KEY || '';

// Formats supportés
const FORMATS = {
  tiktok_vertical:   { w: 1080, h: 1920, label: 'TikTok / Reels / Shorts' },
  youtube_landscape: { w: 1920, h: 1080, label: 'YouTube paysage' },
  youtube_shorts:    { w: 1080, h: 1920, label: 'YouTube Shorts' },
  instagram_square:  { w: 1080, h: 1080, label: 'Instagram carré' },
  instagram_story:   { w: 1080, h: 1920, label: 'Instagram Story' },
  twitter_landscape: { w: 1280, h: 720,  label: 'X / Twitter' },
};

// Transitions FFmpeg disponibles
const XFADE_TRANSITIONS = [
  'fade','wipeleft','wiperight','wipeup','wipedown',
  'slideleft','slideright','slideup','slidedown',
  'circlecrop','rectcrop','distance','fadeblack','fadewhite',
  'radial','smoothleft','smoothright','smoothup','smoothdown',
  'circleopen','circleclose','horzopen','horzclose','vertopen','vertclose',
  'diagtl','diagtr','diagbl','diagbr','hlslice','hrslice','vuslice','vdslice',
  'dissolve','pixelize','squeezeh','squeezev',
];

fs.mkdirSync(RENDER_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────
//  JOB STORE  (in-memory pour MVP, MySQL pour production)
// ─────────────────────────────────────────────────────────────────
const jobs = new Map();

function createJob(sceneGraph, source = 'json') {
  const id = uuidv4();
  jobs.set(id, {
    id,
    status:     'queued',   // queued | rendering | done | error
    progress:   0,
    createdAt:  Date.now(),
    source,                 // 'json' | 'text' | 'ai'
    sceneGraph,
    outputFile: null,
    downloadUrl: null,
    error:      null,
    log:        [],
  });
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

// Nettoyage auto des vieux jobs (>24h)
setInterval(() => {
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < limit) {
      if (job.outputFile && fs.existsSync(job.outputFile)) {
        fs.unlinkSync(job.outputFile);
      }
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────
//  FFMPEG RENDERER — Scene Graph → MP4
// ─────────────────────────────────────────────────────────────────

/**
 * Escape les caractères spéciaux pour FFmpeg drawtext
 */
function escapeDrawtext(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Évalue une expression de position (ex: "w*0.15", "h/2") en pixels entiers.
 * drawbox n'accepte PAS les expressions — on les résout côté JS.
 */
function evalExpr(expr, W, H) {
  if (typeof expr === 'number') return Math.round(expr);
  const s = String(expr).replace(/\bw\b/gi, W).replace(/\bh\b/gi, H);
  try { return Math.round(Function(`"use strict";return (${s})`)() || 0); }
  catch { return 0; }
}

/**
 * Convertit une couleur hex en format FFmpeg (0xRRGGBB ou 0xRRGGBBAA)
 */
function toFFmpegColor(hex, alpha = 'ff') {
  const clean = hex.replace('#', '');
  return `0x${clean}${alpha}`;
}

/**
 * Trouve un fichier de police disponible sur le système
 */
function findFont(bold = false) {
  const candidates = bold
    ? [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        'C:/Windows/Fonts/arialbd.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
      ]
    : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        'C:/Windows/Fonts/arial.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
      ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return ''; // FFmpeg utilisera sa police par défaut
}

/**
 * Construit un filtre drawtext pour un élément texte
 */
function buildDrawtext(el, sceneW, sceneH, font) {
  const style    = el.style || {};
  const fontsize = style.fontsize || style.fontSize || 60;
  const color    = style.fontcolor || style.color || '#ffffff';
  const bold     = style.bold || false;
  const shadow   = style.shadow || false;
  const text     = escapeDrawtext(el.content || el.text || '');

  // Position
  let x = el.x || '(w-tw)/2';
  let y = el.y || '(h-th)/2';
  // Raccourcis
  if (x === 'center') x = '(w-tw)/2';
  if (y === 'center') y = '(h-th)/2';

  const fontFile  = font || findFont(bold);
  const fontParam = fontFile ? `fontfile='${fontFile}':` : '';
  const shadowParam = shadow
    ? `shadowcolor=black@0.8:shadowx=3:shadowy=3:`
    : '';

  return `drawtext=${fontParam}text='${text}':fontsize=${fontsize}:fontcolor=${color}:x=${x}:y=${y}:${shadowParam}`;
}

/**
 * Construit un filtre de fond (color, gradient)
 * Pour les gradients, on utilise geq (lent mais sans dépendance)
 */
function buildBackground(bg, w, h, duration, fps) {
  if (!bg || bg.type === 'color' || !bg.type) {
    const color = (bg && bg.color) ? bg.color.replace('#', '') : '000000';
    return {
      input: [`-f`, `lavfi`, `-i`, `color=c=${color}:s=${w}x${h}:d=${duration}:r=${fps}`],
      label: 'bg_solid',
    };
  }
  if (bg.type === 'gradient') {
    // Gradient via geq: interpole entre color1 et color2 verticalement
    const c1 = bg.color1 || bg.colors?.[0] || '#000000';
    const c2 = bg.color2 || bg.colors?.[1] || '#333333';
    const r1 = parseInt(c1.slice(1,3), 16);
    const g1 = parseInt(c1.slice(3,5), 16);
    const b1 = parseInt(c1.slice(5,7), 16);
    const r2 = parseInt(c2.slice(1,3), 16);
    const g2 = parseInt(c2.slice(3,5), 16);
    const b2 = parseInt(c2.slice(5,7), 16);
    const geq = [
      `r='${r1}+(${r2}-${r1})*Y/H'`,
      `g='${g1}+(${g2}-${g1})*Y/H'`,
      `b='${b1}+(${b2}-${b1})*Y/H'`,
    ].join(':');
    // Génère 1 frame et la loop
    return {
      input: [
        `-f`, `lavfi`,
        `-i`, `color=c=black:s=${w}x${h}:d=1:r=1`,
      ],
      geq,
      duration,
      fps,
      label: 'bg_gradient',
    };
  }
  // Fallback: noir
  return {
    input: [`-f`, `lavfi`, `-i`, `color=c=000000:s=${w}x${h}:d=${duration}:r=${fps}`],
    label: 'bg_fallback',
  };
}


// ─────────────────────────────────────────────────────────────────
//  buildFfmpegCmd — Construit args FFmpeg sans spawner (mode stream)
// ─────────────────────────────────────────────────────────────────
async function buildFfmpegCmd(jobId, sceneGraph) {
  const fmt    = FORMATS[sceneGraph.format] || FORMATS.tiktok_vertical;
  const W      = sceneGraph.resolution?.width  || fmt.w;
  const H      = sceneGraph.resolution?.height || fmt.h;
  const FPS    = sceneGraph.fps || 30;
  const scenes = sceneGraph.scenes || [];
  if (scenes.length === 0) throw new Error('Aucune scène définie');

  const font     = findFont(false);
  const fontBold = findFont(true);
  const inputs   = [];
  const filters  = [];
  let inputIdx   = 0;
  const sceneLabels = [];

  for (let si = 0; si < scenes.length; si++) {
    const scene    = scenes[si];
    const duration = scene.duration || 3;
    const bg       = scene.background || { type: 'color', color: '#000000' };
    const elements = scene.elements   || [];

    if (bg.type === 'gradient') {
      const c1 = bg.color1 || bg.colors?.[0] || '#000000';
      const c2 = bg.color2 || bg.colors?.[1] || '#333333';
      const r1 = parseInt(c1.replace('#','').slice(0,2), 16);
      const g1 = parseInt(c1.replace('#','').slice(2,4), 16);
      const b1 = parseInt(c1.replace('#','').slice(4,6), 16);
      const r2 = parseInt(c2.replace('#','').slice(0,2), 16);
      const g2 = parseInt(c2.replace('#','').slice(2,4), 16);
      const b2 = parseInt(c2.replace('#','').slice(4,6), 16);
      inputs.push(`-f`, `lavfi`, `-i`,
        `color=c=black:s=${W}x${H}:d=${duration}:r=${FPS}`);
      const geq = `geq=r='${r1}+(${r2}-${r1})*Y/H':g='${g1}+(${g2}-${g1})*Y/H':b='${b1}+(${b2}-${b1})*Y/H'`;
      filters.push(`[${inputIdx}:v]${geq},setsar=1[bg${si}]`);
    } else {
      const rawHex = (bg.color || '#000000').replace('#', '');
      inputs.push(`-f`, `lavfi`, `-i`,
        `color=c=0x${rawHex}:s=${W}x${H}:d=${duration}:r=${FPS}`);
      filters.push(`[${inputIdx}:v]setsar=1[bg${si}]`);
    }
    inputIdx++;

    let prevLabel = `bg${si}`;
    for (let ei = 0; ei < elements.length; ei++) {
      const el = elements[ei];
      const nextLabel = `sc${si}_el${ei}`;
      if (el.type === 'text') {
        const fontFile  = el.style?.bold ? fontBold : font;
        const fontsize  = el.style?.fontsize || el.style?.fontSize || 60;
        const color     = el.style?.fontcolor || el.style?.color || '#ffffff';
        const shadow    = el.style?.shadow ? 'shadowcolor=black@0.8:shadowx=3:shadowy=3:' : '';
        const fontParam = fontFile ? `fontfile='${fontFile}':` : '';
        let x = el.x || '(w-tw)/2';
        let y = el.y || '(h-th)/2';
        if (x === 'center') x = '(w-tw)/2';
        if (y === 'center') y = '(h-th)/2';
        let enableExpr = '1';
        const anim = el.animation || {};
        if (anim.type === 'fade_in' || anim.type === 'appear') enableExpr = `gte(t,${anim.start||0})`;
        const textEscaped = escapeDrawtext(el.content || el.text || '');
        const dt = `drawtext=${fontParam}text='${textEscaped}':fontsize=${fontsize}:fontcolor=${color}:x=${x}:y=${y}:${shadow}enable='${enableExpr}'`;
        filters.push(`[${prevLabel}]${dt}[${nextLabel}]`);
        prevLabel = nextLabel;
      } else if (el.type === 'rect' || el.type === 'box') {
        const bx = evalExpr(el.x||'0',W,H), by = evalExpr(el.y||'0',W,H);
        const bw = evalExpr(el.width||W,W,H), bh = evalExpr(el.height||'100',W,H);
        const bc = `0x${(el.color||'#ffffff').replace('#','')}`;
        filters.push(`[${prevLabel}]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${bc}@${el.opacity||0.5}:t=fill[${nextLabel}]`);
        prevLabel = nextLabel;
      } else if (el.type === 'line') {
        const lx1 = evalExpr(el.x1||'0',W,H), ly1 = evalExpr(el.y1||'h/2',W,H);
        const lw  = Math.max(1, evalExpr(el.x2||'w',W,H) - lx1);
        const lc  = `0x${(el.color||'#f5a623').replace('#','')}`;
        filters.push(`[${prevLabel}]drawbox=x=${lx1}:y=${ly1}:w=${lw}:h=3:color=${lc}:t=fill[${nextLabel}]`);
        prevLabel = nextLabel;
      }
    }
    filters.push(`[${prevLabel}]null[scene${si}]`);
    sceneLabels.push(`scene${si}`);
  }

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
    let cumulDuration = scenes[0]?.duration || 3;
    for (let i = 1; i < sceneLabels.length; i++) {
      const trans     = transMap[i - 1];
      const transDur  = trans?.duration || 0.5;
      const transType = XFADE_TRANSITIONS.includes(trans?.type) ? trans.type : 'fade';
      const offset    = Math.max(0, cumulDuration - transDur);
      const xfLabel   = `xf${i}`;
      filters.push(`[${current}][${sceneLabels[i]}]xfade=transition=${transType}:duration=${transDur}:offset=${offset}[${xfLabel}]`);
      current = xfLabel;
      cumulDuration += (scenes[i]?.duration || 3) - transDur;
    }
    finalLabel = current;
  }

  const audio = sceneGraph.audio || { type: 'none' };
  let hasAudio = false;
  if (audio.type === 'file' && audio.path && fs.existsSync(audio.path)) {
    inputs.push(`-i`, audio.path);
    hasAudio = true;
    inputIdx++;
  }
  const silentIdx = inputIdx;
  if (!hasAudio) inputs.push(`-f`, `lavfi`, `-i`, `anullsrc=channel_layout=stereo:sample_rate=44100`);

  const filterStr   = filters.join('; ');
  const audioMapIdx = hasAudio ? inputIdx - 1 : silentIdx;

  return [
    ...inputs,
    `-filter_complex`, filterStr,
    `-map`, `[${finalLabel}]`,
    `-map`, `${audioMapIdx}:a`,
    `-shortest`,
    `-c:v`, `libx264`,
    `-preset`, `fast`,
    `-crf`, `23`,
    `-pix_fmt`, `yuv420p`,
    `-c:a`, `aac`,
    `-b:a`, `128k`,
    `-movflags`, `frag_keyframe+empty_moov`,
    `-f`, `mp4`,
    `-y`,
    `pipe:1`,
  ];
}

/**
 * Render principal : sceneGraph → MP4
 * Retourne le chemin du fichier généré
 */
async function renderVideo(jobId, sceneGraph) {
  const log = (msg) => {
    console.log(`[${jobId.slice(0,8)}] ${msg}`);
    const job = jobs.get(jobId);
    if (job) job.log.push(msg);
  };

  log('Démarrage du rendu...');

  // ── Résolution & format ──────────────────────────────────────
  const fmt    = FORMATS[sceneGraph.format] || FORMATS.tiktok_vertical;
  const W      = sceneGraph.resolution?.width  || fmt.w;
  const H      = sceneGraph.resolution?.height || fmt.h;
  const FPS    = sceneGraph.fps || 30;
  const scenes = sceneGraph.scenes || [];

  if (scenes.length === 0) throw new Error('Aucune scène définie');

  const outputFile = null; // mode stream: pas de fichier
  const font       = findFont(false);
  const fontBold   = findFont(true);
  log(`Résolution: ${W}x${H} @ ${FPS}fps — ${scenes.length} scène(s)`);

  // ── Construire la commande FFmpeg ────────────────────────────
  // Approche: inputs séparés pour chaque scène + filter_complex
  const inputs  = [];
  const filters = [];
  let inputIdx  = 0;

  // Pour chaque scène: 1 input color/lavfi + filters drawtext
  const sceneLabels = [];

  for (let si = 0; si < scenes.length; si++) {
    const scene    = scenes[si];
    const duration = scene.duration || 3;
    const bg       = scene.background || { type: 'color', color: '#000000' };
    const elements = scene.elements   || [];

    // ── Input background ────────────────────────────────────────
    if (bg.type === 'gradient') {
      // Gradient: on génère via geq sur un source color noir
      const c1 = bg.color1 || bg.colors?.[0] || '#000000';
      const c2 = bg.color2 || bg.colors?.[1] || '#333333';
      const r1 = parseInt(c1.replace('#','').slice(0,2), 16);
      const g1 = parseInt(c1.replace('#','').slice(2,4), 16);
      const b1 = parseInt(c1.replace('#','').slice(4,6), 16);
      const r2 = parseInt(c2.replace('#','').slice(0,2), 16);
      const g2 = parseInt(c2.replace('#','').slice(2,4), 16);
      const b2 = parseInt(c2.replace('#','').slice(4,6), 16);

      // Source noir pour geq
      inputs.push(`-f`, `lavfi`, `-i`,
        `color=c=black:s=${W}x${H}:d=${duration}:r=${FPS}`);
      const geq = `geq=r='${r1}+(${r2}-${r1})*Y/H':g='${g1}+(${g2}-${g1})*Y/H':b='${b1}+(${b2}-${b1})*Y/H'`;
      filters.push(`[${inputIdx}:v]${geq},setsar=1[bg${si}]`);
    } else {
      // Couleur solide — FFmpeg exige 0xRRGGBB ou nom de couleur
      const rawHex = (bg.color || '#000000').replace('#', '');
      const color  = `0x${rawHex}`;
      inputs.push(`-f`, `lavfi`, `-i`,
        `color=c=${color}:s=${W}x${H}:d=${duration}:r=${FPS}`);
      filters.push(`[${inputIdx}:v]setsar=1[bg${si}]`);
    }
    inputIdx++;

    // ── Elements: textes ────────────────────────────────────────
    let prevLabel = `bg${si}`;

    for (let ei = 0; ei < elements.length; ei++) {
      const el = elements[ei];
      const nextLabel = `sc${si}_el${ei}`;

      if (el.type === 'text') {
        const fontFile = (el.style?.bold ? fontBold : font);
        const fontsize = el.style?.fontsize || el.style?.fontSize || 60;
        const color    = el.style?.fontcolor || el.style?.color || '#ffffff';
        const shadow   = el.style?.shadow ? `shadowcolor=black@0.8:shadowx=3:shadowy=3:` : '';
        const fontParam = fontFile ? `fontfile='${fontFile}':` : '';

        let x = el.x || '(w-tw)/2';
        let y = el.y || '(h-th)/2';
        if (x === 'center') x = '(w-tw)/2';
        if (y === 'center') y = '(h-th)/2';

        // Animation enable: fade_in, appear
        let enableExpr = '1';
        const anim = el.animation || {};
        if (anim.type === 'fade_in' || anim.type === 'appear') {
          const start = anim.start || 0;
          enableExpr = `gte(t,${start})`;
        }

        const textEscaped = escapeDrawtext(el.content || el.text || '');
        const dt = `drawtext=${fontParam}text='${textEscaped}':fontsize=${fontsize}:fontcolor=${color}:x=${x}:y=${y}:${shadow}enable='${enableExpr}'`;
        filters.push(`[${prevLabel}]${dt}[${nextLabel}]`);
        prevLabel = nextLabel;

      } else if (el.type === 'rect' || el.type === 'box') {
        const bx = evalExpr(el.x || '0', W, H);
        const by = evalExpr(el.y || '0', W, H);
        const bw = evalExpr(el.width  || W, W, H);
        const bh = evalExpr(el.height || '100', W, H);
        const bc = `0x${(el.color || '#ffffff').replace('#', '')}`;
        const alpha = el.opacity || 0.5;
        filters.push(`[${prevLabel}]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${bc}@${alpha}:t=fill[${nextLabel}]`);
        prevLabel = nextLabel;

      } else if (el.type === 'line') {
        const lx1 = evalExpr(el.x1 || '0', W, H);
        const ly1 = evalExpr(el.y1 || 'h/2', W, H);
        const lw  = Math.max(1, evalExpr(el.x2 || 'w', W, H) - lx1);
        const lc  = `0x${(el.color || '#f5a623').replace('#', '')}`;
        filters.push(`[${prevLabel}]drawbox=x=${lx1}:y=${ly1}:w=${lw}:h=3:color=${lc}:t=fill[${nextLabel}]`);
        prevLabel = nextLabel;
      }
      // D'autres types: image (overlay), watermark — à ajouter
    }

    // Label final de la scène
    filters.push(`[${prevLabel}]null[scene${si}]`);
    sceneLabels.push(`scene${si}`);
    log(`Scène ${si+1}/${scenes.length}: "${scene.id || si}" — ${duration}s OK`);
  }

  // ── Transitions & Concat ─────────────────────────────────────
  let finalLabel;

  if (sceneLabels.length === 1) {
    // Une seule scène
    finalLabel = sceneLabels[0];
  } else {
    // Chaîner les scènes avec xfade ou concat
    const transitions = sceneGraph.transitions || [];

    // Construire un map: sceneId → transition suivante
    const transMap = {};
    for (const t of transitions) {
      const fromIdx = scenes.findIndex(s => s.id === t.from);
      if (fromIdx >= 0) transMap[fromIdx] = t;
    }

    // Si transitions définies: xfade
    let current = sceneLabels[0];
    let cumulDuration = scenes[0]?.duration || 3;

    for (let i = 1; i < sceneLabels.length; i++) {
      const trans      = transMap[i - 1];
      const transDur   = trans?.duration || 0.5;
      const transType  = XFADE_TRANSITIONS.includes(trans?.type)
                         ? trans.type
                         : 'fade';
      const offset     = Math.max(0, cumulDuration - transDur);
      const xfLabel    = `xf${i}`;

      filters.push(
        `[${current}][${sceneLabels[i]}]xfade=transition=${transType}:duration=${transDur}:offset=${offset}[${xfLabel}]`
      );
      current       = xfLabel;
      cumulDuration += (scenes[i]?.duration || 3) - transDur;
    }
    finalLabel = current;
  }

  // ── Audio ────────────────────────────────────────────────────
  // MVP: silence ou audio file (TTS à ajouter)
  const audio = sceneGraph.audio || { type: 'none' };
  let hasAudio = false;

  if (audio.type === 'file' && audio.path && fs.existsSync(audio.path)) {
    inputs.push(`-i`, audio.path);   // ← audio rejoint le tableau inputs
    hasAudio = true;
    inputIdx++;
  }

  // Silence synthétique — DOIT être dans inputs avant filter_complex
  const silentIdx = inputIdx;
  if (!hasAudio) {
    inputs.push(`-f`, `lavfi`, `-i`, `anullsrc=channel_layout=stereo:sample_rate=44100`);
  }

  // ── Assembler la commande finale ─────────────────────────────
  const filterStr = filters.join('; ');

  const audioMapIdx = hasAudio ? inputIdx - 1 : silentIdx;

  const cmd = [
    ...inputs,                          // tous les inputs (vidéo + audio) avant filter_complex
    `-filter_complex`, filterStr,
    `-map`, `[${finalLabel}]`,
    `-map`, `${audioMapIdx}:a`,
    `-shortest`,
    `-c:v`, `libx264`,
    `-preset`, `fast`,
    `-crf`, `23`,
    `-pix_fmt`, `yuv420p`,
    `-c:a`, `aac`,
    `-b:a`, `128k`,
    `-movflags`, `frag_keyframe+empty_moov`,
    `-f`, `mp4`,
    `-y`,
    `pipe:1`,
  ];

  log(`Commande FFmpeg: ${FFMPEG_BIN} ${cmd.slice(0, 8).join(' ')} ...`);

  // ── Exécuter FFmpeg ──────────────────────────────────────────
  await new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errOut = '';

    proc.stderr.on('data', (data) => {
      const line = data.toString();
      errOut += line;
      // Extraire la progression
      const match = line.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) {
        const job = jobs.get(jobId);
        if (job) {
          // Estimation progression (approximatif)
          const parts = match[1].split(':');
          const secs  = +parts[0]*3600 + +parts[1]*60 + +parts[2];
          const total = scenes.reduce((a, s) => a + (s.duration || 3), 0);
          job.progress = Math.min(99, Math.round((secs / total) * 100));
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        log('FFmpeg terminé avec succès');
        resolve();
      } else {
        log(`FFmpeg erreur (code ${code})`);
        reject(new Error(`FFmpeg a échoué:\n${errOut.slice(-2000)}`));
      }
    });

    proc.on('error', (e) => reject(new Error(`Impossible de lancer FFmpeg: ${e.message}`)));
  });

  return outputFile;
}

// ─────────────────────────────────────────────────────────────────
//  WORKER — Lance le render en background
// ─────────────────────────────────────────────────────────────────
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  updateJob(jobId, { status: 'rendering', progress: 5 });

  try {
    const outputFile = await renderVideo(jobId, job.sceneGraph);
    const downloadUrl = `/api/download/${jobId}`;

    updateJob(jobId, {
      status:      'done',
      progress:    100,
      outputFile,
      downloadUrl,
    });

    console.log(`✅ Job ${jobId.slice(0,8)} terminé → ${outputFile}`);
  } catch (err) {
    console.error(`❌ Job ${jobId.slice(0,8)} échoué:`, err.message);
    updateJob(jobId, {
      status: 'error',
      error:  err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────────────────────────

// POST /api/render — Soumettre un scene graph JSON
app.post('/api/render', (req, res) => {
  try {
    let sceneGraph = req.body;

    // Si le body est une string (JSON collé comme string)
    if (typeof sceneGraph === 'string') {
      sceneGraph = JSON.parse(sceneGraph);
    }
    if (sceneGraph.json) {
      sceneGraph = typeof sceneGraph.json === 'string'
        ? JSON.parse(sceneGraph.json)
        : sceneGraph.json;
    }

    // Validation minimale
    if (!sceneGraph.scenes || !Array.isArray(sceneGraph.scenes)) {
      return res.status(400).json({
        error: 'Le champ "scenes" est requis et doit être un tableau',
      });
    }

    const jobId = createJob(sceneGraph, 'json');

    // Lancer le render en background
    setImmediate(() => processJob(jobId));

    res.json({
      jobId,
      status:    'queued',
      statusUrl: `${BASE_URL}/api/status/${jobId}`,
      message:   'Rendu lancé. Pollez /api/status/:id toutes les 2s.',
    });
  } catch (e) {
    res.status(400).json({ error: `JSON invalide: ${e.message}` });
  }
});

// GET /api/status/:id — Statut d'un job
app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });

  res.json({
    id:          job.id,
    status:      job.status,
    progress:    job.progress,
    downloadUrl: job.downloadUrl,
    error:       job.error,
    createdAt:   job.createdAt,
  });
});

// GET /api/download/:id — Télécharger la vidéo
app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job)            return res.status(404).json({ error: 'Job introuvable' });
  if (job.status !== 'done') return res.status(202).json({ error: 'Pas encore prêt', status: job.status });
  if (!fs.existsSync(job.outputFile)) return res.status(404).json({ error: 'Fichier introuvable' });

  const stat = fs.statSync(job.outputFile);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="intentfilm_${job.id.slice(0,8)}.mp4"`);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(job.outputFile).pipe(res);
});

// GET /api/example — Retourne un exemple de scene graph
app.get('/api/example', (req, res) => {
  res.json(EXAMPLE_SCENE_GRAPH);
});

// GET /api/jobs — Liste des jobs (admin basique)
app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()].map(j => ({
    id:       j.id,
    status:   j.status,
    progress: j.progress,
    source:   j.source,
    createdAt: j.createdAt,
  }));
  res.json(list);
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

// ─────────────────────────────────────────────────────────────────
//  EXEMPLE DE SCENE GRAPH JSON
//  (Que n'importe quelle IA peut générer)
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
//  EXEMPLE DE SCENE GRAPH JSON (corrigé pour 1080x1920)
// ─────────────────────────────────────────────────────────────────
const EXAMPLE_SCENE_GRAPH = {
  "title": "Ma Première Vidéo INTENTFILM",
  "format": "tiktok_vertical",
  "fps": 30,
  "scenes": [
    {
      "id": "intro",
      "duration": 3,
      "background": {
        "type": "color",
        "color": "#0d0d0d"
      },
      "elements": [
        {
          "type": "text",
          "content": "INTENTFILM",
          "x": "(w-tw)/2",
          "y": "460",                    // ≈ (1920/2 - 80)
          "style": {
            "fontsize": 110,
            "fontcolor": "#f5a623",
            "bold": true,
            "shadow": true
          },
          "animation": { "type": "appear", "start": 0.3 }
        },
        {
          "type": "text",
          "content": "Tu décris. Le moteur génère.",
          "x": "(w-tw)/2",
          "y": "620",
          "style": {
            "fontsize": 38,
            "fontcolor": "#cccccc"
          },
          "animation": { "type": "appear", "start": 1.0 }
        },
        {
          "type": "line",
          "x1": 162,          // 1080 * 0.15
          "y1": 860,
          "x2": 756,          // 1080 * 0.7
          "y2": 860,
          "color": "#f5a623"
        }
      ]
    },
    {
      "id": "hook",
      "duration": 4,
      "background": {
        "type": "gradient",
        "color1": "#0a0a2e",
        "color2": "#1a0050"
      },
      "elements": [
        {
          "type": "rect",
          "x": "0",
          "y": "576",           // 1920 * 0.3
          "width": "1080",
          "height": "200",
          "color": "#f5a623",
          "opacity": 0.12
        },
        {
          "type": "text",
          "content": "🎬 100 000 vues",
          "x": "(w-tw)/2",
          "y": "616",
          "style": {
            "fontsize": 72,
            "fontcolor": "#ffffff",
            "bold": true
          }
        },
        {
          "type": "text",
          "content": "en 24 heures",
          "x": "(w-tw)/2",
          "y": "706",
          "style": {
            "fontsize": 50,
            "fontcolor": "#f5a623"
          }
        },
        {
          "type": "text",
          "content": "avec la bonne vidéo.",
          "x": "(w-tw)/2",
          "y": "1152",
          "style": {
            "fontsize": 36,
            "fontcolor": "#aaaaaa"
          }
        }
      ]
    },
    {
      "id": "cta",
      "duration": 3,
      "background": {
        "type": "gradient",
        "color1": "#1a0000",
        "color2": "#3d0000"
      },
      "elements": [
        {
          "type": "text",
          "content": "Génère ta vidéo",
          "x": "(w-tw)/2",
          "y": "672",
          "style": {
            "fontsize": 70,
            "fontcolor": "#ffffff",
            "bold": true,
            "shadow": true
          }
        },
        {
          "type": "text",
          "content": "GRATUITEMENT",
          "x": "(w-tw)/2",
          "y": "762",
          "style": {
            "fontsize": 80,
            "fontcolor": "#ff4444",
            "bold": true
          }
        },
        {
          "type": "text",
          "content": "intentfilm.com",
          "x": "(w-tw)/2",
          "y": "1344",
          "style": {
            "fontsize": 42,
            "fontcolor": "#f5a623"
          }
        }
      ]
    }
  ],
  "transitions": [
    { "from": "intro", "to": "hook", "type": "fade",      "duration": 0.5 },
    { "from": "hook",  "to": "cta",  "type": "wipeup",    "duration": 0.6 }
  ],
  "audio": {
    "type": "none"
  }
};

// ─────────────────────────────────────────────────────────────────
//  LANDING PAGE HTML (intégrée dans le serveur)
// ─────────────────────────────────────────────────────────────────
const HTML_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>INTENTFILM — Tu décris. Le moteur génère.</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@300;400;600&family=Crimson+Pro:ital,wght@0,300;0,600;1,300&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#f5a623;
  --gold-dim:#c8821a;
  --red:#ff3b3b;
  --bg:#080808;
  --bg2:#0f0f0f;
  --bg3:#161616;
  --border:#1e1e1e;
  --text:#e8e8e8;
  --muted:#666;
  --font-display:'Bebas Neue',sans-serif;
  --font-mono:'IBM Plex Mono',monospace;
  --font-body:'Crimson Pro',Georgia,serif;
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);
  color:var(--text);
  font-family:var(--font-body);
  font-size:18px;
  line-height:1.6;
  overflow-x:hidden;
}

/* ── GRAIN OVERLAY ── */
body::before{
  content:'';
  position:fixed;inset:0;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
  pointer-events:none;z-index:9999;opacity:0.5;
}

/* ── HERO ── */
.hero{
  min-height:100vh;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;
  padding:60px 24px;
  position:relative;
  background:radial-gradient(ellipse 80% 60% at 50% 0%, #1a0b00 0%, var(--bg) 70%);
}
.hero::after{
  content:'';
  position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg, transparent, var(--gold), transparent);
}
.badge{
  display:inline-block;
  border:1px solid var(--gold);
  color:var(--gold);
  font-family:var(--font-mono);
  font-size:11px;
  letter-spacing:0.2em;
  padding:5px 16px;
  margin-bottom:32px;
  text-transform:uppercase;
}
.hero h1{
  font-family:var(--font-display);
  font-size:clamp(80px, 18vw, 200px);
  line-height:0.88;
  letter-spacing:0.04em;
  color:#fff;
  margin-bottom:8px;
}
.hero h1 span{color:var(--gold)}
.tagline{
  font-family:var(--font-mono);
  font-size:clamp(14px,2vw,18px);
  color:var(--muted);
  letter-spacing:0.08em;
  margin-bottom:40px;
}
.hero-cta{
  display:flex;gap:16px;flex-wrap:wrap;justify-content:center;
}
.btn{
  font-family:var(--font-mono);
  font-size:13px;
  letter-spacing:0.12em;
  text-transform:uppercase;
  padding:14px 32px;
  cursor:pointer;
  border:none;
  text-decoration:none;
  display:inline-block;
  transition:all 0.2s;
}
.btn-primary{
  background:var(--gold);
  color:#000;
  font-weight:600;
}
.btn-primary:hover{background:#fff;color:#000}
.btn-outline{
  background:transparent;
  color:var(--gold);
  border:1px solid var(--gold);
}
.btn-outline:hover{background:var(--gold);color:#000}

/* ── STATS ── */
.stats{
  display:flex;gap:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);
  overflow:hidden;
}
.stat{
  flex:1;padding:40px 20px;text-align:center;
  border-right:1px solid var(--border);
}
.stat:last-child{border-right:none}
.stat-n{
  font-family:var(--font-display);
  font-size:56px;
  color:var(--gold);
  display:block;
}
.stat-l{
  font-family:var(--font-mono);
  font-size:12px;
  color:var(--muted);
  letter-spacing:0.15em;
  text-transform:uppercase;
}

/* ── SECTION ── */
section{padding:80px 24px;max-width:1200px;margin:0 auto}
.section-label{
  font-family:var(--font-mono);
  font-size:11px;
  color:var(--gold);
  letter-spacing:0.25em;
  text-transform:uppercase;
  margin-bottom:16px;
}
h2{
  font-family:var(--font-display);
  font-size:clamp(40px,7vw,80px);
  line-height:0.92;
  letter-spacing:0.04em;
  margin-bottom:8px;
}
.sub{
  font-family:var(--font-mono);
  font-size:14px;
  color:var(--muted);
  margin-bottom:48px;
}

/* ── DEMO STUDIO ── */
.studio{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:2px;
  background:var(--border);
  border:1px solid var(--border);
}
@media(max-width:800px){.studio{grid-template-columns:1fr}}
.studio-panel{
  background:var(--bg2);
  padding:28px;
}
.studio-panel h3{
  font-family:var(--font-mono);
  font-size:11px;
  letter-spacing:0.2em;
  text-transform:uppercase;
  color:var(--muted);
  margin-bottom:16px;
  padding-bottom:12px;
  border-bottom:1px solid var(--border);
}
.studio-tabs{
  display:flex;gap:2px;margin-bottom:16px;
}
.tab{
  font-family:var(--font-mono);
  font-size:12px;
  padding:8px 20px;
  cursor:pointer;
  background:var(--bg3);
  color:var(--muted);
  border:none;
  letter-spacing:0.1em;
  text-transform:uppercase;
  transition:all 0.15s;
}
.tab.active{background:var(--gold);color:#000;font-weight:600}
.tab-content{display:none}
.tab-content.active{display:block}
textarea{
  width:100%;
  background:var(--bg);
  border:1px solid var(--border);
  color:var(--text);
  font-family:var(--font-mono);
  font-size:12px;
  padding:16px;
  resize:vertical;
  min-height:320px;
  line-height:1.6;
  outline:none;
  transition:border-color 0.2s;
}
textarea:focus{border-color:var(--gold-dim)}
textarea::placeholder{color:#333}
input[type=text]{
  width:100%;
  background:var(--bg);
  border:1px solid var(--border);
  color:var(--text);
  font-family:var(--font-mono);
  font-size:14px;
  padding:14px 16px;
  outline:none;
  transition:border-color 0.2s;
  margin-bottom:12px;
}
input[type=text]:focus{border-color:var(--gold-dim)}
.render-actions{
  display:flex;gap:8px;margin-top:12px;align-items:center;
  flex-wrap:wrap;
}
.select-format{
  background:var(--bg);
  border:1px solid var(--border);
  color:var(--text);
  font-family:var(--font-mono);
  font-size:12px;
  padding:10px 14px;
  cursor:pointer;
  outline:none;
  flex:1;
  min-width:160px;
}
.render-btn{
  background:var(--gold);
  color:#000;
  font-family:var(--font-mono);
  font-size:12px;
  font-weight:600;
  letter-spacing:0.15em;
  text-transform:uppercase;
  padding:11px 28px;
  border:none;
  cursor:pointer;
  transition:all 0.15s;
  white-space:nowrap;
}
.render-btn:hover{background:#fff}
.render-btn:disabled{background:#333;color:#666;cursor:not-allowed}

/* ── STATUS & PREVIEW ── */
.preview-panel{
  display:flex;flex-direction:column;gap:16px;
}
.status-box{
  background:var(--bg);
  border:1px solid var(--border);
  padding:16px;
  font-family:var(--font-mono);
  font-size:12px;
  min-height:80px;
  color:var(--muted);
}
.status-box .status-done{color:#4ade80}
.status-box .status-error{color:var(--red)}
.status-box .status-rendering{color:var(--gold)}
.progress-bar{
  width:100%;height:3px;
  background:var(--border);
  margin-top:8px;
  overflow:hidden;
}
.progress-fill{
  height:100%;
  background:var(--gold);
  width:0%;
  transition:width 0.5s ease;
}
.video-container{
  background:var(--bg);
  border:1px solid var(--border);
  aspect-ratio:9/16;
  max-height:420px;
  display:flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  position:relative;
}
.video-container video{
  width:100%;height:100%;object-fit:contain;
}
.video-placeholder{
  display:flex;flex-direction:column;align-items:center;gap:12px;
  color:#2a2a2a;
  font-family:var(--font-mono);
  font-size:12px;
  letter-spacing:0.1em;
}
.video-placeholder svg{opacity:0.3}
.log-box{
  background:var(--bg);
  border:1px solid var(--border);
  padding:12px 16px;
  font-family:var(--font-mono);
  font-size:11px;
  color:#444;
  max-height:100px;
  overflow-y:auto;
  display:none;
}
.log-box.visible{display:block}

/* ── SCHEMA JSON ── */
.schema-section{
  background:var(--bg2);
  border:1px solid var(--border);
  padding:40px;
  margin-top:40px;
}
.schema-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:20px;
  margin-top:24px;
}
.schema-card{
  background:var(--bg);
  border:1px solid var(--border);
  padding:20px;
}
.schema-card h4{
  font-family:var(--font-mono);
  font-size:12px;
  color:var(--gold);
  margin-bottom:8px;
  letter-spacing:0.1em;
}
.schema-card p{
  font-family:var(--font-mono);
  font-size:11px;
  color:var(--muted);
  line-height:1.7;
}
code{
  font-family:var(--font-mono);
  font-size:11px;
  background:var(--bg3);
  padding:2px 6px;
  color:var(--gold);
  border:1px solid var(--border);
}

/* ── GALLERY ── */
.gallery{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:2px;
}
.gallery-item{
  aspect-ratio:9/16;
  background:var(--bg2);
  border:1px solid var(--border);
  position:relative;
  overflow:hidden;
  cursor:pointer;
}
.gallery-item:hover .gallery-overlay{opacity:1}
.gallery-overlay{
  position:absolute;inset:0;
  background:rgba(0,0,0,0.7);
  display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity 0.2s;
}
.gallery-label{
  position:absolute;bottom:0;left:0;right:0;
  padding:12px;
  background:linear-gradient(transparent,rgba(0,0,0,0.9));
  font-family:var(--font-mono);
  font-size:11px;
  color:#ccc;
  letter-spacing:0.08em;
}
.gallery-thumb{
  width:100%;height:100%;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--font-display);
  font-size:32px;
  color:#1a1a1a;
}

/* ── PRICING ── */
.plans{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:2px;
  background:var(--border);
  border:1px solid var(--border);
  margin-top:40px;
}
.plan{
  background:var(--bg2);
  padding:40px 32px;
  position:relative;
}
.plan.featured{background:#0d0800}
.plan-badge{
  position:absolute;top:20px;right:20px;
  background:var(--gold);
  color:#000;
  font-family:var(--font-mono);
  font-size:10px;
  font-weight:600;
  letter-spacing:0.15em;
  text-transform:uppercase;
  padding:4px 10px;
}
.plan-name{
  font-family:var(--font-display);
  font-size:40px;
  letter-spacing:0.06em;
  margin-bottom:4px;
}
.plan-price{
  font-family:var(--font-mono);
  font-size:13px;
  color:var(--muted);
  margin-bottom:24px;
  padding-bottom:24px;
  border-bottom:1px solid var(--border);
}
.plan-price strong{
  font-size:36px;
  color:var(--text);
  font-family:var(--font-display);
  letter-spacing:0.04em;
}
.plan-features{
  list-style:none;
  margin-bottom:32px;
}
.plan-features li{
  font-family:var(--font-mono);
  font-size:12px;
  color:var(--muted);
  padding:8px 0;
  border-bottom:1px solid var(--border);
  letter-spacing:0.06em;
}
.plan-features li::before{content:'→  ';color:var(--gold)}

/* ── CONTACT ── */
.contact-strip{
  background:var(--bg2);
  border-top:1px solid var(--border);
  border-bottom:1px solid var(--border);
  padding:60px 24px;
  text-align:center;
}
.wa-btn{
  display:inline-flex;
  align-items:center;
  gap:12px;
  background:#25d366;
  color:#000;
  font-family:var(--font-mono);
  font-size:13px;
  font-weight:600;
  letter-spacing:0.12em;
  text-transform:uppercase;
  padding:16px 36px;
  text-decoration:none;
  transition:all 0.2s;
  margin-top:24px;
}
.wa-btn:hover{background:#fff}
.wa-btn svg{flex-shrink:0}

/* ── FOOTER ── */
footer{
  padding:40px 24px;
  text-align:center;
  border-top:1px solid var(--border);
  font-family:var(--font-mono);
  font-size:11px;
  color:#333;
  letter-spacing:0.12em;
}

/* ── ANIMATIONS ── */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.pulsing{animation:pulse 1.5s ease-in-out infinite}
@keyframes slide-in{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
.slide-in{animation:slide-in 0.4s ease}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border)}
::-webkit-scrollbar-thumb:hover{background:var(--gold-dim)}

@media(max-width:600px){
  .stats{flex-direction:column}
  .stat{border-right:none;border-bottom:1px solid var(--border)}
  .studio-panel{padding:20px}
  section{padding:60px 16px}
}
</style>
</head>
<body>

<!-- ── HERO ── -->
<header class="hero">
  <div class="badge">Moteur de génération vidéo IA</div>
  <h1>INTENT<span>FILM</span></h1>
  <p class="tagline">TU DÉCRIS &nbsp;·&nbsp; LE MOTEUR GÉNÈRE &nbsp;·&nbsp; TU PUBLIES</p>
  <div class="hero-cta">
    <a href="#studio" class="btn btn-primary">→ Générer maintenant</a>
    <a href="#plans" class="btn btn-outline">Voir les plans</a>
  </div>
</header>

<!-- ── STATS ── -->
<div class="stats">
  <div class="stat">
    <span class="stat-n">10×</span>
    <span class="stat-l">Plus rapide</span>
  </div>
  <div class="stat">
    <span class="stat-n">0€</span>
    <span class="stat-l">Pour commencer</span>
  </div>
  <div class="stat">
    <span class="stat-n">720p</span>
    <span class="stat-l">Résolution max free</span>
  </div>
  <div class="stat">
    <span class="stat-n">50+</span>
    <span class="stat-l">Effets Hollywood</span>
  </div>
</div>

<!-- ── STUDIO DÉMO ── -->
<section id="studio">
  <div class="section-label">Studio de génération</div>
  <h2>GÉNÈRE<br>TA VIDÉO</h2>
  <p class="sub">Colle un JSON · Décris en texte · Publie en 60 secondes</p>

  <div class="studio">
    <!-- Panel gauche: input -->
    <div class="studio-panel">
      <h3>Source</h3>
      <div class="studio-tabs">
        <button class="tab active" onclick="switchTab('json')">JSON</button>
        <button class="tab" onclick="switchTab('text')">Texte libre</button>
      </div>

      <!-- JSON Tab -->
      <div class="tab-content active" id="tab-json">
        <textarea id="json-input" placeholder="Colle ton scene graph JSON ici...
(Clique sur ▼ Exemple pour charger un exemple)"></textarea>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="loadExample()" style="font-size:11px;padding:8px 16px">
            ▼ Charger l'exemple
          </button>
          <button class="btn btn-outline" onclick="formatJSON()" style="font-size:11px;padding:8px 16px">
            { } Formater JSON
          </button>
        </div>
      </div>

      <!-- Text Tab -->
      <div class="tab-content" id="tab-text">
        <p style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-bottom:12px">
          ⚡ Mode IA actif — Décris ta vidéo en français, l'IA génère le JSON automatiquement
        </p>
        <input type="text" id="text-prompt" placeholder='Ex: "Vidéo TikTok 15s sur les 5 habitudes des millionnaires, fond noir, textes dorés, transitions rapides"'>
        <textarea id="text-context" placeholder="Contexte additionnel (optionnel): ton, style, couleurs..." style="min-height:160px;margin-top:0"></textarea>
      </div>

      <div class="render-actions">
        <select class="select-format" id="format-select">
          <option value="tiktok_vertical">TikTok / Reels / Shorts (9:16)</option>
          <option value="youtube_landscape">YouTube paysage (16:9)</option>
          <option value="instagram_square">Instagram carré (1:1)</option>
          <option value="youtube_shorts">YouTube Shorts (9:16)</option>
        </select>
        <button class="render-btn" id="render-btn" onclick="startRender()">
          ▶ GÉNÉRER
        </button>
      </div>
    </div>

    <!-- Panel droit: preview & status -->
    <div class="studio-panel preview-panel">
      <h3>Aperçu & Résultat</h3>

      <div class="status-box" id="status-box">
        <span style="color:#2a2a2a;font-family:var(--font-mono);font-size:12px">
          En attente d'un job…
        </span>
        <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      </div>

      <div class="video-container" id="video-container">
        <div class="video-placeholder">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
          <span>La vidéo apparaît ici</span>
        </div>
      </div>

      <div class="log-box" id="log-box"></div>

      <div id="download-area" style="display:none;margin-top:8px">
        <a id="download-link" class="btn btn-primary" style="width:100%;text-align:center;display:block">
          ↓ TÉLÉCHARGER LA VIDÉO MP4
        </a>
      </div>
    </div>
  </div>
</section>

<!-- ── SCHEMA JSON ── -->
<div style="max-width:1200px;margin:0 auto;padding:0 24px 80px">
  <div class="schema-section">
    <div class="section-label">Référence technique</div>
    <h2 style="font-size:36px">SCENE GRAPH JSON</h2>
    <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin-top:8px">
      N'importe quelle IA (Claude, GPT, Gemini) peut générer ce format. Structure complète ↓
    </p>
    <div class="schema-grid">
      <div class="schema-card">
        <h4>Racine du document</h4>
        <p>
          <code>title</code> : Titre de la vidéo<br>
          <code>format</code> : tiktok_vertical | youtube_landscape | instagram_square | youtube_shorts<br>
          <code>fps</code> : 24 | 30 | 60<br>
          <code>scenes[]</code> : Tableau de scènes<br>
          <code>transitions[]</code> : Effets entre scènes<br>
          <code>audio</code> : Configuration audio
        </p>
      </div>
      <div class="schema-card">
        <h4>Objet scene</h4>
        <p>
          <code>id</code> : Identifiant unique<br>
          <code>duration</code> : Durée en secondes<br>
          <code>background</code> : Fond (color | gradient)<br>
          <code>elements[]</code> : Éléments visuels<br>
          <br>
          Background type <code>color</code> → champ <code>color: "#hex"</code><br>
          Background type <code>gradient</code> → champs <code>color1</code> + <code>color2</code>
        </p>
      </div>
      <div class="schema-card">
        <h4>Éléments visuels</h4>
        <p>
          Type <code>text</code> : Texte avec style<br>
          Type <code>rect</code> : Rectangle coloré<br>
          Type <code>line</code> : Ligne décorative<br>
          <br>
          Champs: <code>content</code>, <code>x</code>, <code>y</code>,
          <code>width</code>, <code>height</code>, <code>color</code>, <code>opacity</code>
        </p>
      </div>
      <div class="schema-card">
        <h4>Style texte</h4>
        <p>
          <code>fontsize</code> : Taille en px<br>
          <code>fontcolor</code> : Couleur hex<br>
          <code>bold</code> : true | false<br>
          <code>shadow</code> : true | false<br>
          <br>
          Position: expression FFmpeg ou valeur pixel.<br>
          Ex: <code>"(w-tw)/2"</code> = centré horizontalement
        </p>
      </div>
      <div class="schema-card">
        <h4>Transitions</h4>
        <p>
          <code>from</code> : id scène source<br>
          <code>to</code> : id scène destination<br>
          <code>type</code> : fade | wipeleft | wiperight | wipeup | wipedown | slideleft | slideright | circlecrop | dissolve | pixelize | radial | …<br>
          <code>duration</code> : Durée en secondes
        </p>
      </div>
      <div class="schema-card">
        <h4>Audio (MVP)</h4>
        <p>
          <code>type: "none"</code> → Silence (défaut)<br>
          <code>type: "file"</code> → Fichier audio local<br>
          <br>
          Prochainement:<br>
          <code>type: "tts"</code> → Text-to-speech IA<br>
          <code>type: "music"</code> → Musique générée
        </p>
      </div>
    </div>
  </div>
</div>

<!-- ── GALLERY ── -->
<section id="gallery">
  <div class="section-label">Créations de la communauté</div>
  <h2>EXEMPLES</h2>
  <p class="sub">Vidéos générées par des utilisateurs · Clique pour voir le JSON source</p>
  <div class="gallery">
    ${['Motivation', 'Finance', 'Lifestyle', 'Business', 'Sport', 'Tech'].map((label, i) => `
    <div class="gallery-item" onclick="loadTemplate('${label.toLowerCase()}')">
      <div class="gallery-thumb" style="background:linear-gradient(135deg, hsl(${i*40+200},40%,8%), hsl(${i*40+230},50%,15%))">
        ${label[0]}
      </div>
      <div class="gallery-overlay">
        <span style="font-family:var(--font-mono);font-size:11px;color:white;letter-spacing:0.1em">CHARGER →</span>
      </div>
      <div class="gallery-label">${label}</div>
    </div>`).join('')}
  </div>
</section>

<!-- ── PLANS ── -->
<section id="plans">
  <div class="section-label">Abonnements</div>
  <h2>PLANS &<br>TARIFS</h2>
  <p class="sub">Commence gratuitement · Monte en puissance</p>

  <div class="plans">
    <div class="plan">
      <div class="plan-name">FREE</div>
      <div class="plan-price"><strong>0€</strong> / mois</div>
      <ul class="plan-features">
        <li>1 vidéo par jour</li>
        <li>720p maximum</li>
        <li>Watermark INTENTFILM</li>
        <li>Formats TikTok & Shorts</li>
        <li>20 templates inclus</li>
        <li>Export MP4</li>
      </ul>
      <a href="#studio" class="btn btn-outline" style="width:100%;text-align:center">Commencer</a>
    </div>

    <div class="plan featured">
      <div class="plan-badge">Populaire</div>
      <div class="plan-name">PRO</div>
      <div class="plan-price"><strong>9€</strong> / mois</div>
      <ul class="plan-features">
        <li>50 vidéos par jour</li>
        <li>1080p Full HD</li>
        <li>Sans watermark</li>
        <li>Tous les formats</li>
        <li>50+ effets Hollywood</li>
        <li>Génération IA via texte</li>
        <li>Historique & dashboard</li>
        <li>Support WhatsApp</li>
      </ul>
      <a href="https://wa.me/240555445514" class="btn btn-primary" style="width:100%;text-align:center" target="_blank">Souscrire →</a>
    </div>

    <div class="plan">
      <div class="plan-name">STUDIO</div>
      <div class="plan-price"><strong>29€</strong> / mois</div>
      <ul class="plan-features">
        <li>Vidéos illimitées</li>
        <li>4K (bientôt)</li>
        <li>API accès direct</li>
        <li>Lipsync automatique</li>
        <li>Avatar IA</li>
        <li>Multi-comptes</li>
        <li>Self-host option</li>
        <li>Support prioritaire</li>
      </ul>
      <a href="https://wa.me/240555445514" class="btn btn-outline" style="width:100%;text-align:center" target="_blank">Contacter →</a>
    </div>
  </div>
</section>

<!-- ── CONTACT ── -->
<div class="contact-strip" id="contact">
  <div class="section-label">Support & Ventes</div>
  <h2 style="font-family:var(--font-display);font-size:clamp(36px,6vw,70px)">
    UNE QUESTION ?
  </h2>
  <p style="font-family:var(--font-mono);font-size:14px;color:var(--muted);margin-top:8px">
    On répond sous 2h · En français · 7j/7
  </p>
  <a href="https://wa.me/240555445514" class="wa-btn" target="_blank">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="#000"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
    WhatsApp : +240 555 445 514
  </a>
</div>

<!-- ── FOOTER ── -->
<footer>
  <p style="letter-spacing:0.2em;font-size:13px;margin-bottom:12px;color:#444">INTENTFILM</p>
  <p>© 2025 INTENTFILM · Tu décris. Le moteur génère. · Tous droits réservés</p>
  <p style="margin-top:8px">
    <a href="#studio" style="color:var(--gold);text-decoration:none;margin:0 12px">STUDIO</a>
    <a href="#plans" style="color:var(--muted);text-decoration:none;margin:0 12px">PLANS</a>
    <a href="/api/example" style="color:var(--muted);text-decoration:none;margin:0 12px" target="_blank">API</a>
    <a href="https://wa.me/240555445514" style="color:var(--muted);text-decoration:none;margin:0 12px" target="_blank">CONTACT</a>
  </p>
</footer>

<!-- ── JAVASCRIPT ── -->
<script>
const EXAMPLE_JSON = ${JSON.stringify(EXAMPLE_SCENE_GRAPH, null, 2)};

// Templates communauté (placeholders pour démo)
const TEMPLATES = {
  motivation: {
    ...EXAMPLE_JSON,
    title: "Template Motivation",
    scenes: EXAMPLE_JSON.scenes.map(s => ({
      ...s,
      background: { type: 'gradient', color1: '#0d0700', color2: '#2a1000' },
      elements: s.elements.map(el => el.type === 'text'
        ? { ...el, style: { ...(el.style||{}), fontcolor: '#f5a623' } }
        : el)
    }))
  },
  finance: {
    ...EXAMPLE_JSON,
    title: "Template Finance",
    scenes: [{
      id: 'hook', duration: 4,
      background: { type: 'color', color: '#020a02' },
      elements: [
        { type: 'text', content: '💰 5 ASTUCES', x: '(w-tw)/2', y: 'h*0.25',
          style: { fontsize: 85, fontcolor: '#00ff88', bold: true, shadow: true } },
        { type: 'text', content: 'pour investir en Afrique', x: '(w-tw)/2', y: 'h*0.25+100',
          style: { fontsize: 40, fontcolor: '#ffffff' } },
        { type: 'text', content: 'même avec 10 000 FCFA', x: '(w-tw)/2', y: 'h*0.55',
          style: { fontsize: 36, fontcolor: '#aaaaaa' } }
      ]
    }],
    transitions: []
  },
};
for (const t of ['lifestyle','business','sport','tech']) {
  TEMPLATES[t] = { ...EXAMPLE_JSON, title: \`Template \${t.charAt(0).toUpperCase()+t.slice(1)}\` };
}

// ── Tabs ──────────────────────────────────────────────────────
let currentTab = 'json';
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t,i) => {
    t.classList.toggle('active', (i === 0 && tab === 'json') || (i === 1 && tab === 'text'));
  });
  document.getElementById('tab-json').classList.toggle('active', tab === 'json');
  document.getElementById('tab-text').classList.toggle('active', tab === 'text');
}

// ── Load Example ─────────────────────────────────────────────
function loadExample() {
  document.getElementById('json-input').value = JSON.stringify(EXAMPLE_JSON, null, 2);
  switchTab('json');
}
function loadTemplate(name) {
  const t = TEMPLATES[name] || EXAMPLE_JSON;
  document.getElementById('json-input').value = JSON.stringify(t, null, 2);
  switchTab('json');
  document.getElementById('studio').scrollIntoView({ behavior: 'smooth' });
}
function formatJSON() {
  try {
    const val = document.getElementById('json-input').value;
    document.getElementById('json-input').value = JSON.stringify(JSON.parse(val), null, 2);
  } catch(e) {
    showStatus('error', 'JSON invalide: ' + e.message, 0);
  }
}

// ── Status UI ─────────────────────────────────────────────────
function showStatus(type, msg, progress) {
  const box = document.getElementById('status-box');
  const cls = type === 'done' ? 'status-done' : type === 'error' ? 'status-error' : 'status-rendering';
  box.innerHTML = \`<span class="\${cls} \${type==='rendering'?'pulsing':''}">\${msg}</span>
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:\${progress}%"></div></div>\`;
}

// ── Render ────────────────────────────────────────────────────
let pollTimer = null;

async function startRender() {
  const btn = document.getElementById('render-btn');
  btn.disabled = true;
  btn.textContent = '⏳ EN COURS…';
  document.getElementById('download-area').style.display = 'none';
  document.getElementById('log-box').classList.remove('visible');
  document.getElementById('video-container').innerHTML = \`
    <div class="video-placeholder">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polygon points="5,3 19,12 5,21"/></svg>
      <span class="pulsing">Génération en cours…</span>
    </div>\`;

  try {
    let payload;

    if (currentTab === 'json') {
      const raw = document.getElementById('json-input').value.trim();
      if (!raw) throw new Error('Colle un JSON ou charge un exemple d\\'abord');
      payload = JSON.parse(raw);
    } else {
      // Mode texte: envoyer le prompt au endpoint AI (à implémenter)
      const prompt = document.getElementById('text-prompt').value.trim();
      if (!prompt) throw new Error('Décris ta vidéo en quelques mots');
      showStatus('rendering', '🤖 Génération du Scene Graph via IA…', 10);
      const aiRes = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, format: document.getElementById('format-select').value })
      });
      if (!aiRes.ok) throw new Error('IA non configurée. Utilise le mode JSON pour tester.');
      payload = await aiRes.json();
    }

    // Override format
    payload.format = document.getElementById('format-select').value || payload.format;

    showStatus('rendering', '⚙️ Rendu démarré…', 5);

    showStatus('rendering', '⚙️ Rendu en cours… (patienter 10–30s)', 20);

    const res = await fetch('/api/render/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erreur serveur' }));
      throw new Error(err.error || 'Erreur serveur');
    }

    showStatus('rendering', '⬇️ Réception vidéo…', 80);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);

    showStatus('done', '✓ Vidéo prête !', 100);
    document.getElementById('video-container').innerHTML =
      '<video controls autoplay loop src="' + url + '" style="width:100%;height:100%;object-fit:contain"></video>';
    const dl   = document.getElementById('download-area');
    const link = document.getElementById('download-link');
    link.href     = url;
    link.download = 'intentfilm_video.mp4';
    dl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '▶ GÉNÉRER';

  } catch (e) {
    showStatus('error', '✗ ' + e.message, 0);
    btn.disabled = false;
    btn.textContent = '▶ GÉNÉRER';
  }
}

function pollJob(jobId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(\`/api/status/\${jobId}\`);
      const data = await res.json();

      if (data.status === 'rendering') {
        showStatus('rendering', \`⚙️ Rendu en cours… \${data.progress}%\`, data.progress);
      } else if (data.status === 'done') {
        clearInterval(pollTimer);
        showStatus('done', '✓ Vidéo prête !', 100);

        // Afficher la vidéo
        const vc = document.getElementById('video-container');
        vc.innerHTML = \`<video controls autoplay loop src="\${data.downloadUrl}" style="width:100%;height:100%;object-fit:contain"></video>\`;

        // Lien téléchargement
        const dl = document.getElementById('download-area');
        const link = document.getElementById('download-link');
        link.href = data.downloadUrl;
        link.download = 'intentfilm_video.mp4';
        dl.style.display = 'block';

        document.getElementById('render-btn').disabled = false;
        document.getElementById('render-btn').textContent = '▶ GÉNÉRER';

      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        showStatus('error', '✗ Erreur: ' + (data.error||'inconnue'), 0);
        const log = document.getElementById('log-box');
        log.textContent = data.error || '';
        log.classList.add('visible');
        document.getElementById('render-btn').disabled = false;
        document.getElementById('render-btn').textContent = '▶ GÉNÉRER';
      }
    } catch(e) {
      // réseau — on continue le polling
    }
  }, 2000);
}

// ── Charger l'exemple au démarrage pour info ─────────────────
window.addEventListener('load', () => {
  const ta = document.getElementById('json-input');
  if (!ta.value) {
    ta.placeholder = 'Colle ton JSON ici ou clique "Charger l\\'exemple" ↓\\n\\nFormat attendu:\\n{\\n  "title": "Ma Vidéo",\\n  "format": "tiktok_vertical",\\n  "fps": 30,\\n  "scenes": [...],\\n  "transitions": [...],\\n  "audio": { "type": "none" }\\n}';
  }
});
</script>
</body>
</html>`;


// ─────────────────────────────────────────────────────────────────
//  POST /api/render/sync — Stream MP4 direct (pas de stockage fichier)
// ─────────────────────────────────────────────────────────────────
app.post('/api/render/sync', async (req, res) => {
  try {
    let sceneGraph = req.body;
    if (typeof sceneGraph === 'string') sceneGraph = JSON.parse(sceneGraph);
    if (sceneGraph.json) sceneGraph = typeof sceneGraph.json === 'string'
      ? JSON.parse(sceneGraph.json) : sceneGraph.json;
    if (!sceneGraph.scenes || !Array.isArray(sceneGraph.scenes))
      return res.status(400).json({ error: '"scenes" requis' });

    const jobId = uuidv4();
    console.log(`[sync:${jobId.slice(0,8)}] Démarrage rendu stream`);
    const cmd = await buildFfmpegCmd(jobId, sceneGraph);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="video.mp4"');

    const proc = spawn(FFMPEG_BIN, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.pipe(res);

    let errOut = '';
    proc.stderr.on('data', d => { errOut += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) console.error(`[sync:${jobId.slice(0,8)}] FFmpeg erreur:`, errOut.slice(-800));
      else console.log(`[sync:${jobId.slice(0,8)}] Terminé OK`);
    });
    proc.on('error', e => {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
    req.on('close', () => proc.kill());

  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: e.message });
  }
});

// ── Landing page route ────────────────────────────────────────────
app.get('/', (req, res) => res.type('html').send(HTML_PAGE));

// ── AI generate endpoint (stub — sera activé avec Gemini/OpenRouter) ──
app.post('/api/ai/generate', async (req, res) => {
  // TODO: Intégrer Gemini API ou OpenRouter
  // Pour l'instant: retourner un scene graph exemple basé sur le prompt
  const { prompt = '', format = 'tiktok_vertical' } = req.body;

  // Stub: on retourne l'exemple en changeant le titre
  const scene = {
    ...EXAMPLE_SCENE_GRAPH,
    title: prompt.slice(0, 60),
    format,
  };

  // Quand Gemini sera configuré:
  if (GEMINI_KEY) {
    try {
      const aiPrompt = `Tu es INTENTFILM, un compilateur de langage naturel en scene graph vidéo.
L'utilisateur veut: "${prompt}"
Format vidéo: ${format}

Génère UNIQUEMENT un JSON valide correspondant à ce schéma (pas d'explication):
${JSON.stringify(EXAMPLE_SCENE_GRAPH, null, 2)}

Adapte le contenu, les couleurs, les textes et la durée au sujet demandé.
Réponds UNIQUEMENT avec le JSON, sans markdown, sans backticks.`;

      const fetch = require('node-fetch');
      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: aiPrompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
          }),
        }
      );
      const gemData = await gemRes.json();
      const text = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = text.replace(/```json|```/g, '').trim();
      const parsed  = JSON.parse(cleaned);
      return res.json(parsed);
    } catch (e) {
      console.error('Gemini erreur:', e.message);
      // Fallback OpenRouter si Gemini échoue
    }
  }

  // Fallback: stub
  return res.json(scene);
});

// ─────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ██╗███╗   ██╗████████╗███████╗███╗   ██╗████████╗███████╗██╗██╗     ███╗   ███╗');
  console.log('  ██║████╗  ██║╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝██╔════╝██║██║     ████╗ ████║');
  console.log('  ██║██╔██╗ ██║   ██║   █████╗  ██╔██╗ ██║   ██║   █████╗  ██║██║     ██╔████╔██║');
  console.log('  ██║██║╚██╗██║   ██║   ██╔══╝  ██║╚██╗██║   ██║   ██╔══╝  ██║██║     ██║╚██╔╝██║');
  console.log('  ██║██║ ╚████║   ██║   ███████╗██║ ╚████║   ██║   ██║     ██║███████╗██║ ╚═╝ ██║');
  console.log('  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝');
  console.log('');
  console.log(`  🎬 INTENTFILM Core Engine v1.0 MVP`);
  console.log(`  ✅ Serveur: http://localhost:${PORT}`);
  console.log(`  📁 Renders: ${RENDER_DIR}`);
  console.log(`  🤖 Gemini: ${GEMINI_KEY ? '✅ configuré' : '⚠️  non configuré (mode JSON uniquement)'}`);
  console.log(`  🔀 OpenRouter: ${OPENROUTER_KEY ? '✅ configuré' : '⚠️  non configuré'}`);
  console.log(`  🎥 FFmpeg: ${FFMPEG_BIN}`);
  console.log('');
  console.log('  API endpoints:');
  console.log(`  POST /api/render        → Soumettre un scene graph`);
  console.log(`  GET  /api/status/:id    → Statut du job`);
  console.log(`  GET  /api/download/:id  → Télécharger la vidéo`);
  console.log(`  GET  /api/example       → Exemple JSON complet`);
  console.log(`  GET  /api/jobs          → Tous les jobs`);
  console.log('');
});

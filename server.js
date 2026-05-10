import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { createApi } from 'unsplash-js';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static('output'));
app.use('/temp', express.static('temp'));

const outputDir = path.resolve('./output');
const tempDir = path.resolve('./temp');

[outputDir, tempDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Unsplash
const unsplash = createApi({
  accessKey: process.env.UNSPLASH_ACCESS_KEY,
  fetch: fetch,
});

// ====================== QUEUE ======================
const jobQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;
  const job = jobQueue.shift();
  try {
    await renderVideo(job);
  } catch (err) {
    console.error(err.message);
  } finally {
    isProcessing = false;
    setTimeout(processQueue, 2000);
  }
}

// ====================== FONCTIONS ======================
async function getCinematicBackground(prompt) {
  try {
    const result = await unsplash.photos.getRandom({
      query: prompt || "epic cinematic landscape",
      orientation: "landscape",
    });
    return result.response?.urls?.regular || "https://picsum.photos/id/1015/1280/720";
  } catch (e) {
    return "https://picsum.photos/id/1015/1280/720";
  }
}

async function generateSpeech(text, outputPath) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata("fr-FR-DeniseNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  await tts.toFile(outputPath, text);
}

// ====================== TEMPLATE HTML (Speaker-aware Lip Sync) ======================
function generateCinematicHTML(json, jobId, bgUrl) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>${json.title || 'Wividai'}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
  <style>
    body { margin:0; overflow:hidden; background:#000; }
    #scene { position:relative; width:1280px; height:720px; overflow:hidden; }
    .bg { 
      position:absolute; inset:0; 
      background-size: cover; 
      background-position: center;
      filter: brightness(0.75) contrast(1.15);
    }
    .character { 
      position:absolute; 
      font-size:160px; 
      filter: drop-shadow(0 0 50px gold); 
      transition: transform 0.08s ease-out;
    }
    .subtitle { 
      position:absolute; bottom:15%; left:50%; transform:translateX(-50%);
      color:#fff; font-size:34px; text-align:center; 
      text-shadow:0 0 30px #000; opacity:0; white-space: nowrap;
    }
  </style>
</head>
<body>
  <div id="scene">
    <div class="bg" id="bg" style="background-image: url('${bgUrl}');"></div>
    ${json.scenes?.map((scene, i) => `
      <div class="character" id="char${i}" style="left:${35 + i * 10}%; bottom:8%;">${scene.emoji || '🦸'}</div>
      <div class="subtitle" id="sub${i}">${scene.lip_sync_text || ''}</div>
    `).join('')}
  </div>

  <audio id="voice" src="/temp/${jobId}.mp3"></audio>

  <script>
    const audio = document.getElementById('voice');
    const tl = gsap.timeline();

    // Ken Burns Effect
    tl.fromTo("#bg", 
      { scale: 1.25, filter: "blur(8px) brightness(0.3)" }, 
      { scale: 1.05, filter: "blur(0px) brightness(0.75)", duration: 3, ease: "power2.out" }
    );

    ${json.scenes?.map((scene, i) => `
      tl.to("#char${i}", { y: -90, scale: 1.08, duration: ${scene.duration_sec || 4} }, ${i * 1.1});
      tl.to("#sub${i}", { opacity: 1, duration: 0.7 }, ${i * 2});
    `).join('')}

    // === Lip Sync intelligent par speaker ===
    let audioCtx, analyser, dataArray;
    const currentSpeaker = ${json.currentSpeaker !== undefined ? json.currentSpeaker : 0};

    function initLipSync() {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 32;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    }

    function animateMouth() {
      if (!analyser) return;
      analyser.getByteFrequencyData(dataArray);
      const volume = dataArray[0] / 255;
      const scaleY = 0.85 + (volume * 0.45);

      // Ne fait vibrer que le personnage qui parle
      const speakerEl = document.getElementById('char' + currentSpeaker);
      if (speakerEl) gsap.set(speakerEl, { scaleY: scaleY });

      requestAnimationFrame(animateMouth);
    }

    window.addEventListener('load', () => {
      initLipSync();
      audio.play().catch(() => {});
      tl.play();
      audio.onplay = () => {
        audioCtx.resume();
        animateMouth();
      };
    });
  </script>
</body>
</html>`;
}

// ====================== RENDU ======================
async function renderVideo(job) {
  const { jsonData, jobId } = job;
  const htmlPath = path.join(tempDir, `${jobId}.html`);
  const audioPath = path.join(tempDir, `${jobId}.mp3`);
  const rawVideoPath = path.join(outputDir, `${jobId}_raw.mp4`);
  const finalVideoPath = path.join(outputDir, `${jobId}.mp4`);

  try {
    const bgPrompt = jsonData.background_prompt || jsonData.title || "epic cinematic";
    const bgUrl = await getCinematicBackground(bgPrompt);

    const fullText = jsonData.scenes?.map(s => s.lip_sync_text).filter(Boolean).join(". ");
    if (fullText) await generateSpeech(fullText, audioPath);

    const html = generateCinematicHTML(jsonData, jobId, bgUrl);
    fs.writeFileSync(htmlPath, html);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    const recorder = new PuppeteerScreenRecorder(page, { fps: 30 });
    await recorder.start(rawVideoPath);

    await page.goto(`http://localhost:${PORT}/temp/${jobId}.html`, { waitUntil: 'networkidle0' });

    await new Promise(r => setTimeout(r, (jsonData.duration || 12) * 1000 + 1500));

    await recorder.stop();
    await browser.close();

    await new Promise((resolve, reject) => {
      ffmpeg(rawVideoPath)
        .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 22', '-pix_fmt yuv420p', '-movflags +faststart'])
        .on('end', resolve)
        .on('error', reject)
        .save(finalVideoPath);
    });

    // Nettoyage
    [htmlPath, rawVideoPath, audioPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));

    console.log(`✅ Vidéo terminée : ${jobId}`);

  } catch (error) {
    console.error("Render error:", error);
  }
}

// ====================== ROUTES ======================
app.post('/generate-from-json', (req, res) => {
  const { json } = req.body;
  if (!json) return res.status(400).json({ error: "JSON requis" });

  const jobId = uuidv4();
  jobQueue.push({ jsonData: json, jobId });
  processQueue();

  res.json({ success: true, jobId, status: "queued" });
});

app.get('/temp/:jobId.html', (req, res) => {
  res.sendFile(path.join(tempDir, req.params.jobId + '.html'));
});

app.get('/status/:jobId', (req, res) => {
  const file = path.join(outputDir, `${req.params.jobId}.mp4`);
  res.json({
    status: fs.existsSync(file) ? "completed" : "processing",
    videoUrl: fs.existsSync(file) ? `/output/${req.params.jobId}.mp4` : null
  });
});

app.get('/', (req, res) => res.sendFile(path.resolve('./test.html')));

app.listen(PORT, () => {
  console.log(`🚀 Wividai PRO vFinal démarré sur http://localhost:${PORT}`);
});
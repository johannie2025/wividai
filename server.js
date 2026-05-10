// server.js - Wividai Renderer (Version Stable Render)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { createApi } = require('unsplash-js');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/output', express.static('output'));
app.use('/temp', express.static('temp'));

const outputDir = path.resolve('./output');
const tempDir = path.resolve('./temp');

[outputDir, tempDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ====================== CONFIG ======================
const unsplash = createApi({
    accessKey: process.env.UNSPLASH_ACCESS_KEY,
    fetch: fetch,
});

const getPuppeteerConfig = () => ({
    headless: "new",
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
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
        console.error(`[Queue Error] Job ${job?.jobId}:`, err.message);
    } finally {
        isProcessing = false;
        setTimeout(processQueue, 2000);
    }
}

// ====================== HELPERS ======================
async function getCinematicBackground(prompt) {
    try {
        const result = await unsplash.photos.getRandom({
            query: prompt || "cinematic epic landscape desert",
            orientation: "landscape",
        });
        return result.response?.urls?.regular || "https://picsum.photos/id/1015/1280/720";
    } catch (e) {
        return "https://picsum.photos/id/1015/1280/720";
    }
}

async function generateSpeech(text, outputPath) {
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata("fr-FR-DeniseNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        await tts.toFile(outputPath, text);
    } catch (e) {
        console.error("[TTS Error]", e.message);
    }
}

// ====================== TEMPLATE HTML ======================
function generateCinematicHTML(json, jobId, bgUrl) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
    <style>
        body { margin:0; overflow:hidden; background:#000; }
        #scene { position:relative; width:1280px; height:720px; overflow:hidden; }
        .bg { position:absolute; inset:0; background-size:cover; background-position:center; filter: brightness(0.75) contrast(1.1); }
        .character { position:absolute; font-size:180px; bottom:15%; left:50%; transform:translateX(-50%); filter: drop-shadow(0 0 40px gold); }
        .subtitle { 
            position:absolute; bottom:8%; left:50%; transform:translateX(-50%);
            color:white; font-size:38px; font-weight:bold; text-shadow: 2px 2px 12px #000;
            background:rgba(0,0,0,0.5); padding:12px 40px; border-radius:25px;
        }
    </style>
</head>
<body>
    <div id="scene">
        <div class="bg" id="bg" style="background-image: url('${bgUrl}');"></div>
        ${json.scenes.map((s, i) => `
            <div class="character" id="char${i}">${s.emoji || '🦸'}</div>
            <div class="subtitle" id="sub${i}">${s.lip_sync_text || ''}</div>
        `).join('')}
    </div>
    <audio id="voice" src="/temp/${jobId}.mp3"></audio>

    <script>
        const audio = document.getElementById('voice');
        const scenes = ${JSON.stringify(json.scenes || [])};
        let currentTime = 0;

        window.addEventListener('load', async () => {
            gsap.to("#bg", { scale: 1.08, duration: ${json.duration || 12}, ease: "none" });

            scenes.forEach((scene, i) => {
                setTimeout(() => {
                    document.querySelectorAll('.subtitle').forEach(s => s.style.opacity = 0);
                    document.getElementById('sub' + i).style.opacity = 1;
                    document.getElementById('char' + i).style.transform = 'translateX(-50%) scale(1.15)';
                }, currentTime * 1000);
                currentTime += (scene.duration_sec || 4);
            });

            try {
                await audio.play();
            } catch (e) {}
            
            window.renderReady = true;
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
        const bgUrl = await getCinematicBackground(jsonData.background_prompt);
        const fullText = jsonData.scenes.map(s => s.lip_sync_text).join(". ");
        
        await generateSpeech(fullText, audioPath);
        fs.writeFileSync(htmlPath, generateCinematicHTML(jsonData, jobId, bgUrl));

        const browser = await puppeteer.launch(getPuppeteerConfig());
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        const recorder = new PuppeteerScreenRecorder(page, { fps: 30 });

        await page.goto(`http://localhost:${PORT}/temp/${jobId}.html`, { waitUntil: 'networkidle0' });
        
        // Attente que l'animation soit prête
        await page.waitForFunction('window.renderReady === true', { timeout: 10000 });

        await recorder.start(rawVideoPath);
        await new Promise(r => setTimeout(r, (jsonData.duration || 12) * 1000 + 800));
        await recorder.stop();
        await browser.close();

        // FFmpeg corrigé
        await new Promise((resolve, reject) => {
            ffmpeg(rawVideoPath)
                .input(audioPath)
                .outputOptions([
                    '-c:v libx264',
                    '-preset veryfast',
                    '-crf 23',
                    '-pix_fmt yuv420p',
                    '-movflags +faststart',
                    '-shortest'
                ])
                .on('end', resolve)
                .on('error', reject)
                .save(finalVideoPath);
        });

        // Nettoyage
        [htmlPath, audioPath, rawVideoPath].forEach(p => {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        });

        console.log(`✅ Vidéo terminée : ${jobId}`);
    } catch (error) {
        console.error(`❌ Échec rendu ${jobId}:`, error.message);
    }
}

// ====================== ROUTES ======================
app.get('/health', (req, res) => {
    res.json({ _ok: true, status: 'running', service: 'wividai-renderer' });
});

app.post('/generate-from-json', (req, res) => {
    const { json } = req.body;
    if (!json) return res.status(400).json({ _ok: false, error: "JSON requis" });

    const jobId = uuidv4();
    jobQueue.push({ jsonData: json, jobId });
    if (!isProcessing) processQueue();

    res.json({ _ok: true, jobId, status: "queued" });
});

app.get('/status/:jobId', (req, res) => {
    const file = path.join(outputDir, `${req.params.jobId}.mp4`);
    const exists = fs.existsSync(file);
    res.json({
        _ok: true,
        status: exists ? "completed" : "processing",
        videoUrl: exists ? `/output/${req.params.jobId}.mp4` : null
    });
});

app.get('/temp/:file', (req, res) => {
    res.sendFile(path.join(tempDir, req.params.file));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'test.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Wividai Renderer démarré sur port ${PORT}`);
});

'use strict';
// Speech transcription REST API — Azure & OpenAI
//
// Start: node server.js
//
// GET  /models      → configured model list for Android dropdown
// GET  /health      → liveness + which models are ready
// POST /transcribe  → fields: audio (WAV/MP3 file), model, language

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const { OpenAI } = require('openai');
const sdk     = require('microsoft-cognitiveservices-speech-sdk');

const PORT       = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app    = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
  }),
});

// ── Models registry ───────────────────────────────────────────────────────────
const ALL_MODELS = [
  { id: 'openai', label: 'OpenAI (gpt-4o-transcribe)', requires: ['OPENAI_API_KEY'] },
  { id: 'azure',  label: 'Azure Speech',               requires: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'] },
  { id: 'qwen',   label: 'Qwen (qwen3-asr-flash-filetrans)', requires: ['QWEN_API_KEY'] },
];

function configuredModels() {
  return ALL_MODELS
    .filter(m => m.requires.every(key => !!process.env[key]))
    .map(({ id, label }) => ({ id, label }));
}

// ── Language helpers ──────────────────────────────────────────────────────────
function getLangConfig(language) {
  if (language === 'en-MY') return { azureLang: 'en-MY', openaiLang: 'en' };
  return { azureLang: 'ms-MY', openaiLang: 'ms' };
}

function getOpenAIPrompt(language) {
  if (language === 'en-MY') return 'Transcribe in English.';
  if (language === 'mixed') return 'Transcribe in Malay and English. Preserve code-switching as spoken.';
  return 'Transkripsi dalam Bahasa Melayu. Sertakan bahasa Inggeris jika ada.';
}

// ── Azure ─────────────────────────────────────────────────────────────────────
function azureTranscribe(filePath, azureLang) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = azureLang;

    const ext = path.extname(filePath).toLowerCase();
    let audioConfig;
    if (ext === '.mp3') {
      const pushStream = sdk.AudioInputStream.createPushStream(
        sdk.AudioStreamFormat.getCompressedFormat(sdk.AudioStreamContainerFormat.MP3)
      );
      fs.createReadStream(filePath)
        .on('data', chunk => pushStream.write(chunk))
        .on('end',  ()    => pushStream.close());
      audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    } else {
      audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(filePath));
    }

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    const segments   = [];

    recognizer.recognized = (_, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        const t = e.result.text.trim();
        if (t) segments.push(t);
      }
    };
    recognizer.canceled = (_, e) => {
      if (e.reason === sdk.CancellationReason.Error)
        return reject(new Error(`Azure: ${e.errorDetails}`));
      recognizer.stopContinuousRecognitionAsync(() => resolve(segments.join(' ')));
    };
    recognizer.sessionStopped = () =>
      recognizer.stopContinuousRecognitionAsync(() => resolve(segments.join(' ')));
    recognizer.startContinuousRecognitionAsync(
      () => {},
      (err) => reject(new Error(`Azure start: ${err}`))
    );
  });
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function openaiTranscribe(filePath, openaiLang, prompt) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.audio.transcriptions.create({
    file:     fs.createReadStream(filePath),
    model:    process.env.OPENAI_MODEL || 'gpt-4o-transcribe',
    language: openaiLang,
    prompt,
  });
  return (res.text || '').trim();
}

// ── Qwen (DashScope native async API) ────────────────────────────────────────
async function qwenTranscribe(filePath) {
  const apiKey  = process.env.QWEN_API_KEY;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // 1. Upload to uguu.se to get a public URL DashScope can fetch
  const form = new FormData();
  form.append('files[]', new Blob([fs.readFileSync(filePath)], { type: 'audio/wav' }), path.basename(filePath));
  const uploadRes  = await fetch('https://uguu.se/upload', { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error(`uguu upload failed: ${uploadRes.status}`);
  const uploadData = await uploadRes.json();
  const fileUrl    = uploadData?.files?.[0]?.url;
  if (!fileUrl) throw new Error(`uguu upload failed: ${JSON.stringify(uploadData)}`);

  // 2. Submit async transcription task
  const taskRes = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription', {
    method: 'POST',
    headers: { ...headers, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model:      'qwen3-asr-flash-filetrans',
      input:      { file_url: fileUrl },
      parameters: { language_hints: ['ms'] },
    }),
  });
  const taskData = await taskRes.json();
  const taskId   = taskData.output?.task_id;
  if (!taskId) throw new Error(`Qwen task submit failed: ${JSON.stringify(taskData)}`);

  // 3. Poll until done (max 2 min)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes  = await fetch(`https://dashscope-intl.aliyuncs.com/api/v1/tasks/${taskId}`, { headers });
    const status     = await statusRes.json();
    const taskStatus = status.output?.task_status;

    if (taskStatus === 'SUCCEEDED') {
      const url    = status.output?.result?.transcription_url;
      const result = await (await fetch(url)).json();
      return (result.transcripts || []).map(t => t.text).join('\n').trim();
    }
    if (taskStatus === 'FAILED') throw new Error(`Qwen task failed: ${JSON.stringify(status.output)}`);
  }
  throw new Error('Qwen transcription timed out after 2 minutes');
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/models', (req, res) => {
  res.json({ success: true, data: configuredModels() });
});

app.get('/health', (req, res) => {
  const models = configuredModels();
  res.json({ success: true, data: { ok: true, configured_models: models.map(m => m.id) } });
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const model    = req.body?.model;
    const language = req.body?.language || 'ms-MY';

    if (!filePath) return res.status(400).json({ success: false, error: 'No audio file uploaded' });
    if (!model)    return res.status(400).json({ success: false, error: 'model field is required' });

    const isConfigured = configuredModels().some(m => m.id === model);
    if (!isConfigured) return res.status(400).json({ success: false, error: `Model "${model}" is not configured or unknown` });

    const { azureLang, openaiLang } = getLangConfig(language);
    const prompt = getOpenAIPrompt(language);

    let transcript;
    if (model === 'openai')     transcript = await openaiTranscribe(filePath, openaiLang, prompt);
    else if (model === 'azure') transcript = await azureTranscribe(filePath, azureLang);
    else if (model === 'qwen')  transcript = await qwenTranscribe(filePath);

    res.json({ success: true, data: { transcript, model, language } });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const models = configuredModels();
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Configured models: ${models.map(m => m.id).join(', ') || 'NONE — check .env'}`);
  if (models.length < ALL_MODELS.length) {
    const missing = ALL_MODELS.filter(m => !models.find(c => c.id === m.id));
    missing.forEach(m => console.warn(`  ⚠ ${m.id} disabled — missing: ${m.requires.filter(k => !process.env[k]).join(', ')}`));
  }
});

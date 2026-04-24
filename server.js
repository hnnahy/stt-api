'use strict';
// Speech Transcription API — model is set by admin, not the user.
//
// HOW TO SWITCH MODELS (admin only):
//   1. Open .env
//   2. Set ACTIVE_MODEL to one of: openai, azure
//   3. Restart the server — all users will use the new model
//
// Android just sends audio + language. No model selection on the user side.
//
// Start: node server.js
//
// GET  /health      → liveness check + which model is active
// POST /transcribe  → fields: audio (WAV/MP3), language

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const { OpenAI } = require('openai');
const sdk     = require('microsoft-cognitiveservices-speech-sdk');

const PORT         = process.env.PORT || 3000;
const ACTIVE_MODEL = process.env.ACTIVE_MODEL || 'openai'; // admin sets this in .env
const UPLOAD_DIR   = path.join(__dirname, 'tmp');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app    = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
  }),
});

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

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, data: { ok: true, active_model: ACTIVE_MODEL } });
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const language = req.body?.language || 'ms-MY';

    if (!filePath) return res.status(400).json({ success: false, error: 'No audio file uploaded' });

    const { azureLang, openaiLang } = getLangConfig(language);
    const prompt = getOpenAIPrompt(language);

    let transcript;
    if (ACTIVE_MODEL === 'openai')     transcript = await openaiTranscribe(filePath, openaiLang, prompt);
    else if (ACTIVE_MODEL === 'azure') transcript = await azureTranscribe(filePath, azureLang);
    else return res.status(500).json({ success: false, error: `Unknown ACTIVE_MODEL "${ACTIVE_MODEL}" in .env` });

    res.json({ success: true, data: { transcript, model: ACTIVE_MODEL, language } });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Active model: ${ACTIVE_MODEL} (change ACTIVE_MODEL in .env to switch)`);
});

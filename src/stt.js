// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable path is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
//
// This is the BATCH path (one WAV → one transcription). Streaming STT (faster-whisper
// WebSocket) lives in src/stt-stream.js; when a streaming provider is configured and
// reachable, main.js sends live PCM to a streaming session instead of this loop, and
// only uses createSTT() as a degrade-to-batch fallback.
const { pcmToWav } = require('./wav');

async function transcribeOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: model || 'whisper-1' });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// Batch fallback for the faster-whisper server: POST the WAV to the server's /transcribe
// endpoint (the reference server in docs/faster-whisper-setup.md exposes both a WS /stream
// endpoint and this HTTP endpoint). `wsUrl` is converted to http(s)://; fetch is global in
// Node 18+ / Electron's main process, so this stays dependency-free.
async function transcribeFasterWhisperHTTP(wsUrl, wav) {
  const httpUrl = wsUrl.replace(/^ws(s?):\/\//i, 'http$1://');
  const res = await fetch(httpUrl.replace(/\/$/, '') + '/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  });
  if (!res.ok) throw new Error('faster-whisper HTTP ' + res.status);
  const json = await res.json().catch(() => ({}));
  return ((json && typeof json.text === 'string') ? json.text : '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const sttCfg = settings.stt || {};
  const whisperModel = sttCfg.model || settings.sttModel || 'whisper-1'; // sttModel: legacy (pre-Phase-3)
  const fwUrl = sttCfg.fasterWhisperURL || '';

  const chain = [];
  // Local faster-whisper first (free, low-latency) when configured — same local-first order
  // the streaming path prefers in src/stt-stream.js.
  if (fwUrl) chain.push({ p: 'faster-whisper', fn: (wav) => transcribeFasterWhisperHTTP(fwUrl, wav) });
  if (keys.openai) chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, whisperModel) });
  if (keys.gemini) chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, transcribeFasterWhisperHTTP };

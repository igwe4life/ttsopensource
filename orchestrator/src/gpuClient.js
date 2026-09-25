import { config } from './config.js';

/**
 * HTTP client for the GPU inference service (replaces the old ttsengine's
 * azureClients.js — this is the ONLY place the orchestrator talks to AI
 * models, and it does so over a plain HTTP API, so the GPU workload can live
 * on RunPod, Hyperstack, a local box, or anywhere else without this file
 * changing (section 3: provider-independent architecture).
 *
 * Simple round-robin across `config.gpu.pool` (if set) gives basic
 * horizontal scaling across multiple GPU workers without a separate load
 * balancer — good enough for a handful of pods; put a real LB in front for
 * larger deployments.
 */
const pool = [config.gpu.baseUrl, ...config.gpu.pool];
let rrIndex = 0;

function nextBaseUrl() {
  const url = pool[rrIndex % pool.length];
  rrIndex++;
  return url;
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(config.gpu.apiKey ? { 'X-Api-Key': config.gpu.apiKey } : {}),
    ...extra,
  };
}

async function postJson(pathName, body, { baseUrl } = {}) {
  const base = baseUrl || nextBaseUrl();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), config.gpu.timeoutMs);
  try {
    const res = await fetch(`${base}${pathName}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GPU service ${pathName} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The main call: transcribe ONE segment's audio once, fan out translate+TTS
 * to every currently-active target language, in a single request. Mirrors
 * gpu-service's /process route 1:1.
 *
 * @param {Buffer} audioBuffer 16kHz mono WAV bytes for this segment
 * @param {string[]} targetLangs currently-subscribed language codes (from
 *   sharedPipelineManager — NOT every enabled language, only the active ones)
 * @param {string} [sourceLangHint] e.g. 'en'
 * @returns {Promise<{source_lang:string, languages: Record<string, {ok:boolean, text?:string, audio_base64?:string, sample_rate?:number, error?:string}>}>}
 */
export async function processSegment(audioBuffer, targetLangs, sourceLangHint = 'en') {
  return postJson('/process', {
    audio_base64: audioBuffer.toString('base64'),
    target_langs: targetLangs,
    source_lang_hint: sourceLangHint,
  });
}

export async function health(baseUrl) {
  const base = baseUrl || nextBaseUrl();
  const res = await fetch(`${base}/health`, { headers: headers() });
  return res.json();
}

export async function models(baseUrl) {
  const base = baseUrl || nextBaseUrl();
  const res = await fetch(`${base}/models`, { headers: headers() });
  return res.json();
}

/** Base64-decode a /process language result's audio into a Buffer, or null. */
export function decodeAudio(languageResult) {
  if (!languageResult || !languageResult.audio_base64) return null;
  return Buffer.from(languageResult.audio_base64, 'base64');
}

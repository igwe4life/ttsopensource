import { config } from './config.js';

/**
 * Thin HTTP helpers for gpu-service's status endpoints only — the actual
 * transcribe/translate/TTS work now goes over gpuStreamClient.js's
 * persistent WebSocket (see live/gpuStreamClient.js), not HTTP POST
 * /process. Kept separate because /health and /models are simple
 * request/response checks with no reason to share a streaming connection.
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

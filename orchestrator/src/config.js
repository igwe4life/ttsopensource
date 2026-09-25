import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // C:\ttsopensource

function num(key, fallback) {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── Language registry — SAME file the GPU service reads. Single source of
// truth (see language-registry/README.md); never duplicate this data. ───────
const registryPath = process.env.LANGUAGE_REGISTRY_PATH
  || path.join(REPO_ROOT, 'language-registry', 'languages.json');
const overridesPath = process.env.LANGUAGE_OVERRIDES_PATH
  || path.join(REPO_ROOT, 'language-registry', 'overrides.json');

/**
 * Recomputes the UI-facing `status` field after overrides are merged in —
 * mirrors scripts/build-registry.js's logic exactly. Needed because an
 * override commonly changes `quality_level` (e.g. after scripts/verify-
 * models.js confirms a checkpoint) without a human remembering to also
 * update the derived `status`; trusting the stored value would silently
 * drift out of sync with quality_level, which is worse than recomputing.
 */
function computeStatus(entry) {
  if (!entry.translation_supported || !entry.tts_supported) return 'unsupported';
  if (!entry.stt_supported || entry.quality_level === 'experimental') return 'experimental';
  if (entry.quality_level === 'medium' || entry.quality_level === 'limited') return 'limited';
  return 'available';
}

function loadLanguageRegistry() {
  const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
  let overrides = {};
  try {
    overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
  } catch {
    // overrides.json is optional
  }
  const byCode = new Map();
  for (const entry of raw.languages) {
    const merged = { ...entry, ...(overrides[entry.language_code] || {}) };
    merged.status = computeStatus(merged);
    byCode.set(entry.language_code, merged);
  }
  return byCode;
}

const languageRegistry = loadLanguageRegistry();

// The 10 target languages for this build — see README for how to widen this
// to the full language-registry set later.
const DEFAULT_TARGET_LANGUAGES = ['es', 'fr', 'pt', 'de', 'it', 'ar', 'hi', 'ja', 'ko', 'zh'];

export const config = {
  // --- GPU inference service — continuous streaming (see
  // gpu-service/app/ws/stream_ws.py) is the only path used now; the old
  // per-segment HTTP /process is gone from the orchestrator side. ──────────
  gpu: {
    baseUrl: process.env.GPU_SERVICE_URL || 'http://localhost:8000', // still used for GET /health, /models
    wsUrl: process.env.GPU_SERVICE_WS_URL || 'ws://localhost:8000/ws/stream',
    apiKey: process.env.GPU_SERVICE_API_KEY || '',
    // Comma-separated list of additional GPU service base URLs, for future
    // multi-pod round robin (not used yet — see gpuStreamClient.js's doc
    // comment on why splitting one chunk's languages across pods doesn't
    // make sense without also duplicating transcription).
    pool: (process.env.GPU_SERVICE_POOL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // --- Continuous audio chunking ────────────────────────────────────────
  chunkSeconds: num('CHUNK_SECONDS', 4),
  chunkOverlapMs: num('CHUNK_OVERLAP_MS', 750),
  // Ceiling for one chunk's full fan-out (transcribe once + translate/TTS
  // for every active language, on the shared GPU connection — see
  // pipeline.js). Keep this generous enough for real GPU-pod variance
  // (network + processing time) now that the target list is curated to
  // working languages only — a too-tight value here was what caused
  // widespread false timeouts during testing, not the fan-out width itself.
  chunkTimeoutMs: num('CHUNK_TIMEOUT_MS', 15000),

  // --- The fixed set of selectable target languages for this build ──────
  targetLanguages: (process.env.TARGET_LANGUAGES || DEFAULT_TARGET_LANGUAGES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // --- RTMP broadcast — one persistent push per language, always-on ──────
  rtmp: {
    baseUrl: process.env.RTMP_SERVER || '',
    // Prefix stream keys during testing (e.g. "test-") so verification
    // pushes don't land on the real per-language keys real viewers might
    // already expect. Empty for production. Only applies to a language
    // that has no explicit key below.
    keyPrefix: process.env.RTMP_KEY_PREFIX || '',
    // Explicit per-language stream keys, e.g.
    // "es:SPANISH_30_HS,fr:FRENCH_109_HS,de:GERMAN_21_HS" — the real
    // production keys, which don't follow any code-derived pattern. A
    // language not listed here falls back to keyPrefix + language code.
    streamKeys: new Map(
      (process.env.RTMP_STREAM_KEYS || '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const [lang, key] = pair.split(':').map((s) => s.trim());
          return [lang, key];
        })
    ),
    /** Resolve the stream key to use for `lang`. */
    keyFor(lang) {
      return this.streamKeys.get(lang) || `${this.keyPrefix}${lang}`;
    },
  },

  // Fixed internal sample rate for the live-mixed translated-audio pipe fed
  // into each language's ffmpeg (see liveAudioMixer.js / resample.js) — TTS
  // engines vary their native output rate, so everything is resampled to
  // this one rate before mixing.
  mixSampleRate: num('MIX_SAMPLE_RATE', 24000),
  // Cap on how much translated audio can queue up waiting to play before
  // the OLDEST excess is dropped to catch back up toward real time (see
  // liveAudioMixer.js) — bounds the delay instead of letting it grow
  // without limit during a processing slowdown.
  mixMaxQueuedSeconds: num('MIX_MAX_QUEUED_SECONDS', 8),

  // --- Audio mixing: how loud the original stays under the dub ───────────
  duckLevel: num('DUCK_LEVEL', 0.2),

  // --- HTTP server (monitoring endpoints only — no browser UI) ───────────
  http: {
    port: num('HTTP_PORT', 4000),
  },

  // --- Language registry accessor (just name lookups now — /languages
  // exposes only config.targetLanguages, not the full ~100+ registry) ─────
  languageEntry(code) {
    return languageRegistry.get(code) || null;
  },
};

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

function bool(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
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

let languageRegistry = loadLanguageRegistry();

export const config = {
  // --- Source ---------------------------------------------------------------
  hlsSegmentSeconds: num('HLS_SEGMENT_SECONDS', 6),
  pollIntervalDivisor: num('POLL_INTERVAL_DIVISOR', 2),

  // --- GPU inference service (provider-independent — section 3) ────────────
  gpu: {
    baseUrl: process.env.GPU_SERVICE_URL || 'http://localhost:8000',
    wsUrl: process.env.GPU_SERVICE_WS_URL || 'ws://localhost:8000/ws/stream',
    apiKey: process.env.GPU_SERVICE_API_KEY || '',
    timeoutMs: num('GPU_SERVICE_TIMEOUT_MS', 20000),
    // Comma-separated list of additional GPU service base URLs for simple
    // round-robin load balancing across multiple GPU workers/pods. The
    // primary baseUrl is always included. See gpuClient.js.
    pool: (process.env.GPU_SERVICE_POOL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // --- Real-time orchestration knobs (section 4) ────────────────────────────
  segmentDeadlineMs: num('SEGMENT_DEADLINE_MS', 12000),
  pipelineConcurrency: num('PIPELINE_CONCURRENCY', 2),
  maxQueueDepth: num('MAX_QUEUE_DEPTH', 8),

  // --- Audio mixing (same fixed-duck-level design as the old engine) ───────
  duckLevel: num('DUCK_LEVEL', 0.10),

  // --- HLS output ────────────────────────────────────────────────────────
  hlsOutput: {
    windowSegments: num('HLS_WINDOW_SEGMENTS', 6), // live sliding-window size
    dir: process.env.HLS_OUTPUT_DIR || 'work/hls_out',
  },

  // --- Shared-pipeline lifecycle (section 5: one pipeline per language,
  // not per viewer) ──────────────────────────────────────────────────────
  pipelineIdleGraceMs: num('PIPELINE_IDLE_GRACE_MS', 30000),

  // --- HTTP API / static HLS server ──────────────────────────────────────
  http: {
    port: num('HTTP_PORT', 4000),
  },

  // --- RTMP output (optional — see rtmp-targets.json.example) ──────────────
  // Only used when --rtmp-targets points at a file; a language listed there
  // gets a persistent RTMP push IN ADDITION TO its normal HLS output, and is
  // pinned active for the life of the process (see index.js), matching the
  // old engine's "always-on dubbing to a fixed destination" model rather
  // than the viewer-driven /select activation used for HLS-only languages.
  rtmp: {
    defaultServer: process.env.RTMP_SERVER || '',
  },

  keepWork: bool('KEEP_WORK', false),

  // --- Language registry accessors ──────────────────────────────────────
  languageEntry(code) {
    return languageRegistry.get(code) || null;
  },
  enabledLanguages() {
    return [...languageRegistry.values()].filter((l) => l.enabled);
  },
  allLanguages() {
    return [...languageRegistry.values()];
  },
  isLanguageEnabled(code) {
    const e = languageRegistry.get(code);
    return !!(e && e.enabled);
  },
  /**
   * Maps a human label ("French", "french") to its registry code ("fr"),
   * by matching against `language_name`/`native_name` — reuses the SAME
   * registry data rather than a second hand-maintained label table (the old
   * engine's config.js had one; this derives it instead, so the two can
   * never drift out of sync).
   * @returns {string|null}
   */
  languageCodeFromLabel(label) {
    if (!label) return null;
    const key = String(label).trim().toLowerCase();
    if (languageRegistry.has(key)) return key; // already a code, e.g. "fr"
    for (const entry of languageRegistry.values()) {
      if (entry.language_name.toLowerCase() === key) return entry.language_code;
      if (entry.native_name?.toLowerCase() === key) return entry.language_code;
    }
    return null;
  },
  reloadLanguageRegistry() {
    languageRegistry = loadLanguageRegistry();
  },
};

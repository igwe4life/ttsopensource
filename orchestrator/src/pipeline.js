// Rewritten for always-on RTMP broadcast (see
// C:\Users\USER\.claude\plans\tranquil-stirring-pixel.md). All configured
// languages are generated continuously regardless of viewers — there is no
// browser UI and no per-viewer activation. Video is never re-encoded or
// stored here: each language's own ffmpeg (rtmpLanguagePusher.js) pulls the
// source directly and mixes in that language's live translated audio.
//
// ONE shared GPU connection, transcribing once and fanning out to every
// active language (not one connection per language): a per-language-
// decoupled version was tried live and made things WORSE once the target
// list was narrowed to only the languages with working TTS voices (es/fr/de)
// — three independent connections meant three independent transcriptions of
// the same audio hitting the GPU simultaneously every chunk (3x the actual
// GPU work), which pushed every language into timeouts that didn't happen
// under the shared/single-transcription model. Per-language decoupling only
// earns its cost (extra transcriptions) when the target list mixes fast and
// permanently-broken languages — with a curated, all-working list, sharing
// one connection is both simpler and lighter on the GPU.
import { captureAudio } from './live/audioCapture.js';
import { createChunker } from './live/chunker.js';
import { createGpuStreamClient } from './live/gpuStreamClient.js';
import { createLiveAudioMixer } from './live/liveAudioMixer.js';
import { createRtmpLanguagePusher } from './live/rtmpLanguagePusher.js';
import { resampleWavToPcm } from './live/resample.js';
import { config } from './config.js';

/**
 * @param {object} opts
 * @param {string} opts.input  source HLS URL — read once here (16kHz mono,
 *   for STT) and again independently by each language's own RTMP pusher
 *   (full video + original audio).
 * @returns {{ shutdown: () => Promise<void>, status: () => object }}
 */
export function runDubbingPipeline({ input }) {
  console.log('[pipeline] ttsopensource always-on RTMP broadcast');
  console.log(`[pipeline]   source: ${input}`);
  console.log(`[pipeline]   languages: ${config.targetLanguages.join(', ')}`);
  console.log(`[pipeline]   rtmp base: ${config.rtmp.baseUrl} (key prefix: "${config.rtmp.keyPrefix}")`);

  const chunker = createChunker({ chunkSeconds: config.chunkSeconds, overlapMs: config.chunkOverlapMs });

  // One live mixer + one persistent RTMP pusher per language, created
  // immediately at startup — always-on, no viewer-driven activation.
  const mixers = new Map();
  const pushers = new Map();
  for (const lang of config.targetLanguages) {
    const rtmpUrl = `${config.rtmp.baseUrl.replace(/\/+$/, '')}/${config.rtmp.keyFor(lang)}`;
    const mixer = createLiveAudioMixer({ sampleRate: config.mixSampleRate, maxQueuedSeconds: config.mixMaxQueuedSeconds });
    const pusher = createRtmpLanguagePusher({
      sourceUrl: input,
      rtmpUrl,
      sampleRate: config.mixSampleRate,
      duckLevel: config.duckLevel,
    });
    mixer.pump((bytes) => pusher.write(bytes));
    mixers.set(lang, mixer);
    pushers.set(lang, pusher);
    console.log(`[pipeline]   [${lang}] -> ${rtmpUrl}`);
  }

  let seq = 0;
  let connected = false;
  // Bounded queue: if chunks arrive faster than the shared GPU connection
  // can process them, drop the OLDEST queued chunk rather than let latency
  // grow without bound.
  const MAX_QUEUE_DEPTH = 2;
  const pendingQueue = [];
  let draining = false;

  const gpuClient = createGpuStreamClient({
    url: config.gpu.wsUrl,
    apiKey: config.gpu.apiKey,
    timeoutMs: config.chunkTimeoutMs,
    onLanguageResult: async (lang, meta, audio) => {
      if (meta.ok && audio) {
        console.log(`[pipeline] [${lang}] "${(meta.text || '').slice(0, 60)}" (${audio.length}B)`);
        try {
          const pcm = await resampleWavToPcm(audio, config.mixSampleRate);
          mixers.get(lang)?.enqueue(pcm);
        } catch (err) {
          console.warn(`[pipeline] [${lang}] resample failed: ${err.message}`);
        }
      } else if (!meta.ok) {
        console.warn(`[pipeline] [${lang}] ${meta.error || 'no result'}`);
      }
    },
  });

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (pendingQueue.length > 0) {
        const wav = pendingQueue.shift();
        const mySeq = seq++;
        // No source_lang_hint: the speaker's language isn't known in
        // advance, so Whisper's own detection drives the English pivot in
        // gpu-service (see process_pipeline.py).
        await gpuClient.sendSegment(mySeq, config.targetLanguages, undefined, wav);
      }
    } finally {
      draining = false;
    }
  }

  const capture = captureAudio(
    input,
    (pcm) => {
      connected = true;
      const wavChunks = chunker.push(pcm);
      for (const wav of wavChunks) {
        if (pendingQueue.length >= MAX_QUEUE_DEPTH) {
          pendingQueue.shift();
          console.warn('[pipeline] chunk queue full; dropping oldest chunk to stay live');
        }
        pendingQueue.push(wav);
      }
      if (wavChunks.length > 0) drainQueue();
    },
    (err) => {
      connected = false;
      console.warn(`[pipeline] capture: ${err.message}`);
    }
  );
  connected = true;

  return {
    shutdown: async () => {
      capture.stop();
      gpuClient.close();
      for (const pusher of pushers.values()) pusher.stop();
    },
    status: () => ({
      connected,
      source: input,
      queueDepth: pendingQueue.length,
      gpuConnected: gpuClient.connected,
      rtmp: Object.fromEntries(
        [...pushers.entries()].map(([lang, p]) => [lang, { alive: p.alive, reconnecting: p.reconnecting }])
      ),
    }),
  };
}

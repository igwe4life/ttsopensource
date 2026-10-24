// Always-on RTMP broadcast. All configured languages are generated
// continuously regardless of viewers — there is no browser UI and no
// per-viewer activation. Video is never re-encoded or stored here: each
// language's own ffmpeg (rtmpLanguagePusher.js) reads the source (directly, or
// through the shared local relay — sourceRelay.js) and mixes in that
// language's live translated audio.
//
// GPU pool: the language list is sharded across one or more gpu-service pods
// (GPU_POOL). Every chunk is sent to EVERY pod, each with only its own shard of
// languages — a pod transcribes the chunk itself (~0.6 s, on its own GPU) and
// then translates + synthesizes just its shard, so adding a pod adds language
// capacity without making any single pod's per-chunk time longer. A pod that
// is down only silences its own shard; the other shards keep broadcasting.
//
// Within one pod this is still ONE shared WebSocket transcribing once and
// fanning out (a per-language-connection design was tried live and made
// things worse: N connections = N transcriptions of the same audio).
import { captureAudio } from './live/audioCapture.js';
import { createChunker } from './live/chunker.js';
import { createGpuStreamClient } from './live/gpuStreamClient.js';
import { createLiveAudioMixer } from './live/liveAudioMixer.js';
import { createRtmpLanguagePusher } from './live/rtmpLanguagePusher.js';
import { createSourceRelay } from './live/sourceRelay.js';
import { resampleWavToPcm } from './live/resample.js';
import { config } from './config.js';

const LOG_TEXT_LANGS = 3; // translated text is only echoed for the first few languages (100 lines/chunk is noise)

/**
 * @param {object} opts
 * @param {string} opts.input     source HLS URL — read once here (16kHz mono,
 *   for STT); the video + original audio reach each pusher either directly
 *   or through the local relay (config.sourceRelay).
 * @param {number} opts.httpPort  port this process serves /relay on
 * @returns {{ shutdown: () => Promise<void>, status: () => object, relayDir: string|null }}
 */
export function runDubbingPipeline({ input, httpPort }) {
  const languages = config.targetLanguages;
  const nodes = config.gpu.nodes;
  console.log('[pipeline] ttsopensource always-on RTMP broadcast');
  console.log(`[pipeline]   source: ${input}`);
  console.log(`[pipeline]   languages (${languages.length}): ${languages.join(', ')}`);
  console.log(`[pipeline]   rtmp base: ${config.rtmp.baseUrl} (key prefix: "${config.rtmp.keyPrefix}")`);
  console.log(`[pipeline]   gpu nodes: ${nodes.length} | source relay: ${config.sourceRelay.enabled ? 'on' : 'off'}`);

  const chunker = createChunker({ chunkSeconds: config.chunkSeconds, overlapMs: config.chunkOverlapMs });

  // ── Shard the language list across GPU nodes (round-robin, so the
  // alternating cheap/expensive order of the list spreads evenly). ─────────
  const shards = buildShards(languages, nodes.length, config.gpu.shards);
  nodes.forEach((n, i) => console.log(`[pipeline]   node ${i} (${n.baseUrl.replace(/^https?:\/\//, '').split('.')[0]}): ${shards[i].length} languages`));

  // ── One live mixer per language, created immediately (always-on). ───────
  const mixers = new Map();
  const pushers = new Map();
  for (const lang of languages) {
    const mixer = createLiveAudioMixer({ sampleRate: config.mixSampleRate, maxQueuedSeconds: config.mixMaxQueuedSeconds });
    mixer.pump((bytes) => pushers.get(lang)?.write(bytes));
    mixers.set(lang, mixer);
  }

  // ── One persistent RTMP pusher per language. Started in small batches so
  // ~100 ffmpeg processes do not all spin up (and hit the RTMP server) at once. ──
  const relay = config.sourceRelay.enabled ? createSourceRelay({ sourceUrl: input, dir: config.sourceRelay.dir }) : null;
  let stopped = false;
  // Only these languages get an RTMP pusher (see PUSH_LANGUAGES); the rest are still processed.
  const pushSet = new Set(config.rtmp.pushLanguages.length ? config.rtmp.pushLanguages : languages);
  const pushLanguages = languages.filter((l) => pushSet.has(l));
  async function startPushers(sourceUrl) {
    const BATCH = 10;
    for (let i = 0; i < pushLanguages.length && !stopped; i += BATCH) {
      for (const lang of pushLanguages.slice(i, i + BATCH)) {
        const rtmpUrl = `${config.rtmp.baseUrl.replace(/\/+$/, '')}/${config.rtmp.keyFor(lang)}`;
        pushers.set(lang, createRtmpLanguagePusher({ sourceUrl, rtmpUrl, sampleRate: config.mixSampleRate, duckLevel: config.duckLevel, dubGain: config.dubGain }));
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`[pipeline] ${pushers.size} RTMP pushers started`);
  }
  if (relay) {
    relay
      .ready()
      .then(() => startPushers(`http://127.0.0.1:${httpPort}/relay/live.m3u8`))
      .catch((err) => console.error(`[pipeline] relay failed: ${err.message} — falling back to direct source pulls`) || startPushers(input));
  } else {
    startPushers(input);
  }

  let seq = 0;
  let connected = false;
  let lastPcmAt = 0; // when audio last arrived from the source (status() reports staleness)
  // Bounded queue: if chunks arrive faster than the GPU pods can process
  // them, drop the OLDEST queued chunk rather than let latency grow without bound.
  const MAX_QUEUE_DEPTH = 2;
  const pendingQueue = [];
  let draining = false;
  let droppedChunks = 0;
  // Per-segment stage timings reported by each gpu-service pod (pod logs are
  // not reachable on RunPod, so the orchestrator is where they get logged).
  let nodeTimings = nodes.map(() => null);
  let nodeWall = nodes.map(() => null);
  // Rolling window of recent chunk timings, surfaced in status() -> /health.
  const recent = []; // { wall, gpu, stt, fanout, hadSpeech }
  const RECENT_MAX = 60;
  let segmentsDone = 0;
  const failed = new Map(); // lang -> last error (surfaced in /health)

  function handleResult(nodeIdx, lang, meta, audio) {
    if (meta.timings) nodeTimings[nodeIdx] = meta.timings;
    if (meta.ok && audio) {
      failed.delete(lang);
      if (languages.indexOf(lang) < LOG_TEXT_LANGS) {
        console.log(`[pipeline] [${lang}] "${(meta.text || '').slice(0, 60)}" (${audio.length}B)`);
      }
      resampleWavToPcm(audio, config.mixSampleRate)
        .then((pcm) => mixers.get(lang)?.enqueue(pcm))
        .catch((err) => console.warn(`[pipeline] [${lang}] resample failed: ${err.message}`));
    } else if (!meta.ok) {
      const msg = meta.error || 'no result';
      if (msg !== 'no speech detected') {
        if (failed.get(lang) !== msg) console.warn(`[pipeline] [${lang}] ${msg}`);
        failed.set(lang, msg);
      }
    }
  }

  const clients = nodes.map((node, i) =>
    createGpuStreamClient({
      url: node.wsUrl,
      apiKey: config.gpu.apiKey,
      timeoutMs: config.chunkTimeoutMs,
      onLanguageResult: (lang, meta, audio) => handleResult(i, lang, meta, audio),
    })
  );

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
        nodeTimings = nodes.map(() => null);
        nodeWall = nodes.map(() => null);
        const t0 = Date.now();
        await Promise.all(
          clients.map(async (client, i) => {
            if (shards[i].length === 0) return;
            const t = Date.now();
            await client.sendSegment(mySeq, shards[i], undefined, wav);
            nodeWall[i] = Date.now() - t;
          })
        );
        const wall = Date.now() - t0;
        const tms = nodeTimings.filter(Boolean);
        const mx = (k) => (tms.length ? Math.max(...tms.map((t) => t[k] || 0)) : null);
        const tm = tms.length ? { stt_ms: mx('stt_ms'), translate_en_ms: mx('translate_en_ms'), translate_batch_ms: mx('translate_batch_ms'), fanout_ms: mx('fanout_ms'), total_ms: mx('total_ms') } : null;
        segmentsDone++;
        recent.push({ wall, gpu: tm?.total_ms ?? null, stt: tm?.stt_ms ?? null, fanout: tm?.fanout_ms ?? null, hadSpeech: !!tm && tm.fanout_ms > 0 });
        if (recent.length > RECENT_MAX) recent.shift();
        console.log(
          `[timing] seg ${mySeq} wall ${wall}ms (budget ${config.chunkSeconds * 1000}ms)` +
            (tm ? ` | stt ${tm.stt_ms} en ${tm.translate_en_ms} batch-tr ${tm.translate_batch_ms} fanout ${tm.fanout_ms} gpu-total ${tm.total_ms}` : ' | no gpu timings') +
            (nodes.length > 1 ? ` | node wall ${nodeWall.join('/')}` : '') +
            ` | queued ${pendingQueue.length} dropped ${droppedChunks}`
        );
      }
    } finally {
      draining = false;
    }
  }

  const capture = captureAudio(
    input,
    (pcm) => {
      connected = true;
      lastPcmAt = Date.now();
      const wavChunks = chunker.push(pcm);
      for (const wav of wavChunks) {
        if (pendingQueue.length >= MAX_QUEUE_DEPTH) {
          pendingQueue.shift();
          droppedChunks++;
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
    relayDir: relay ? relay.dir : null,
    shutdown: async () => {
      stopped = true;
      capture.stop();
      clients.forEach((c) => c.close());
      for (const pusher of pushers.values()) pusher.stop();
      relay?.stop();
    },
    status: () => {
      const rtmp = Object.fromEntries(
        pushLanguages.map((lang) => {
          const p = pushers.get(lang);
          return [lang, { alive: !!p?.alive, reconnecting: !!p?.reconnecting, bufferedKB: Math.round((p?.bufferedBytes || 0) / 1024), droppedKB: Math.round((p?.droppedBytes || 0) / 1024), exits: p?.exits || 0, lastExit: p?.lastExit || null }];
        })
      );
      return {
        // true only while source audio is actually arriving (a wedged capture used to read "connected")
        connected: connected && Date.now() - lastPcmAt < 30000,
        audioAgeSec: lastPcmAt ? Math.round((Date.now() - lastPcmAt) / 1000) : null,
        source: input,
        queueDepth: pendingQueue.length,
        gpuConnected: clients.every((c) => c.connected),
        gpuNodes: clients.map((c, i) => ({ connected: c.connected, languages: shards[i].length })),
        relay: relay ? { alive: relay.alive, segments: relay.segments } : null,
        stats: summarize(recent, segmentsDone, droppedChunks, config.chunkSeconds * 1000, languages.length),
        pushers: { started: pushers.size, alive: Object.values(rtmp).filter((r) => r.alive).length, total: pushLanguages.length },
        failedLanguages: Object.fromEntries(failed),
        rtmp,
      };
    },
  };
}

/**
 * Assigns each language to a GPU node. With GPU_SHARDS (one group per node) a language goes to the node that lists
 * it; anything unlisted, or all languages when GPU_SHARDS is absent, falls back to the least-loaded node (round-robin by position when there is no map).
 * Exported for testing.
 */
export function buildShards(languages, nodeCount, explicit = []) {
  const shards = Array.from({ length: nodeCount }, () => []);
  const usable = explicit.length === nodeCount && explicit.some((g) => g.length > 0);
  const home = new Map();
  if (usable) explicit.forEach((group, node) => group.forEach((lang) => { if (!home.has(lang)) home.set(lang, node); }));
  for (const lang of languages) {
    if (usable && home.has(lang)) { shards[home.get(lang)].push(lang); continue; }
    // unlisted (or no map at all): the node with the fewest languages so far, lowest index on ties.
    // With no map this is exactly round-robin by position.
    let n = 0;
    for (let k = 1; k < nodeCount; k++) if (shards[k].length < shards[n].length) n = k;
    shards[n].push(lang);
  }
  return shards;
}

function summarize(recent, segmentsDone, dropped, budgetMs, languages) {
  const speech = recent.filter((r) => r.hadSpeech);
  const avg = (rows, k) => (rows.length ? Math.round(rows.reduce((a, r) => a + (r[k] || 0), 0) / rows.length) : null);
  const max = (rows, k) => (rows.length ? Math.max(...rows.map((r) => r[k] || 0)) : null);
  return {
    languages,
    budgetMs,
    segmentsDone,
    droppedTotal: dropped,
    window: recent.length,
    wallAvgMs: avg(speech, 'wall'),
    wallMaxMs: max(speech, 'wall'),
    gpuAvgMs: avg(speech, 'gpu'),
    sttAvgMs: avg(speech, 'stt'),
    fanoutAvgMs: avg(speech, 'fanout'),
  };
}

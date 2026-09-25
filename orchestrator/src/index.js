#!/usr/bin/env node
// Adapted from ttsengine/src/index.js — same CLI shape (single-stream flags
// or --stream-config), minus the old per-language-process machinery, since
// one process now serves every language for one source stream (see
// pipeline.js's doc comment for why). RTMP push is back via --rtmp-targets
// (see rtmp-targets.json.example) — HLS output stays the default/always-on
// path; RTMP is opt-in per language, for feeding an existing RTMP-ingest CDN
// the same way the old engine did.
import { runDubbingPipeline } from './pipeline.js';
import { createSharedPipelineManager } from './live/sharedPipelineManager.js';
import { createRtmpOutputManager } from './live/rtmpOutputManager.js';
import { createServer } from './server.js';
import { config } from './config.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const HELP = `
ttsopensource — open-source live HLS translation/dubbing pipeline
  (Whisper/faster-whisper -> NLLB/OPUS-MT -> Piper/XTTS/MMS-TTS, via a GPU
  inference service — see gpu-service/)

USAGE
  node src/index.js -i <hls-url> [--work <dir>] [--http-port <port>]
  node src/index.js --stream-config stream.json
  node src/index.js -i <hls-url> --rtmp-targets rtmp-targets.json

A stream-config JSON looks like:
  { "hls_url": "https://.../playlist.m3u8" }

An rtmp-targets JSON looks like (see rtmp-targets.json.example):
  [
    { "language": "French",  "stream_key": "FRENCH_109_HS",  "rtmp_server": "rtmp://obs1.homestream.live/live" },
    { "language": "Spanish", "stream_key": "SPANISH_109_HS", "rtmp_server": "rtmp://obs1.homestream.live/live" }
  ]
Each entry gets a PERSISTENT RTMP push (one long-running ffmpeg per language,
same model as the old engine) for the whole run, in ADDITION to that
language's normal HLS output — it does not need a viewer to /select it first.

OPTIONS
  --input,    -i <url>     Live HLS URL (master or media playlist)  *required*
  --stream-config <file>   JSON file supplying hls_url
  --rtmp-targets <file>    JSON array of {language, stream_key, rtmp_server}
                           — pushes those languages to RTMP continuously
  --work,     -w <dir>     Scratch + HLS output root (default: ./work)
  --http-port    <port>    HTTP API / HLS host port (default: ${config.http.port})
  --help,     -h           Show this help

Viewers select a language over HTTP for HLS, they don't restart the process:
  POST /select   { "lang": "es" }   -> { hls_url: "/hls/es/playlist.m3u8" }
  GET  /languages                   -> full registry with availability status

ENV (see .env.example)
  GPU_SERVICE_URL           GPU inference service base URL
  RTMP_SERVER               default RTMP server base if an rtmp-targets entry omits rtmp_server
  SEGMENT_DEADLINE_MS / PIPELINE_CONCURRENCY   live orchestration knobs
`.trim();

function parseArgs(argv) {
  const out = { input: null, streamConfig: null, rtmpTargets: null, workDir: null, httpPort: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-i':
      case '--input':
        out.input = argv[++i];
        break;
      case '--stream-config':
        out.streamConfig = argv[++i];
        break;
      case '--rtmp-targets':
        out.rtmpTargets = argv[++i];
        break;
      case '-w':
      case '--work':
        out.workDir = argv[++i];
        break;
      case '--http-port':
        out.httpPort = Number(argv[++i]);
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      default:
        if (!a.includes('=')) console.warn(`[ttsopensource] ignoring unknown arg: ${a}`);
    }
  }
  return out;
}

/**
 * Loads an rtmp-targets JSON file, resolves each entry's language label to a
 * registry code, starts a persistent RTMP pusher per entry, and pins that
 * language permanently active in `sharedPipeline` (so it's always included
 * in the target_langs sent to the GPU service, regardless of HLS viewers).
 */
async function setupRtmpTargets(file, sharedPipeline) {
  const raw = await fs.readFile(path.resolve(file), 'utf8');
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('--rtmp-targets file must contain a non-empty JSON array.');
  }

  const rtmpManager = createRtmpOutputManager();
  for (const [i, def] of list.entries()) {
    const lang = config.languageCodeFromLabel(def.language);
    if (!lang) throw new Error(`rtmp-targets[${i}]: unrecognized language '${def.language}'`);
    const entry = config.languageEntry(lang);
    if (!entry?.enabled) {
      console.warn(`[rtmp] '${def.language}' (${lang}) is not enabled in the language registry — skipping`);
      continue;
    }
    if (!def.stream_key && !def.rtmp_url) {
      throw new Error(`rtmp-targets[${i}]: needs stream_key (+ rtmp_server) or rtmp_url`);
    }
    const server = (def.rtmp_server || config.rtmp.defaultServer || '').replace(/\/+$/, '');
    const rtmpUrl = def.rtmp_url || `${server}/${def.stream_key}`;
    if (!def.rtmp_url && !server) {
      throw new Error(`rtmp-targets[${i}]: no rtmp_server given and RTMP_SERVER env is unset`);
    }

    await rtmpManager.addTarget(lang, rtmpUrl);
    sharedPipeline.subscribe(lang); // pinned active — never unsubscribed, so never idles out
    console.log(`[rtmp] '${lang}' pinned active, pushing to ${rtmpUrl}`);
  }
  return rtmpManager;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let input = args.input;
  if (args.streamConfig) {
    const raw = await fs.readFile(path.resolve(args.streamConfig), 'utf8');
    const cfg = JSON.parse(raw);
    input = input || cfg.hls_url;
  }
  if (!input) {
    console.error('Error: --input or --stream-config (with hls_url) is required.\n');
    console.log(HELP);
    process.exit(1);
  }

  const workDir = args.workDir || 'work';
  const httpPort = args.httpPort || config.http.port;

  const sharedPipeline = createSharedPipelineManager();

  let rtmpManager = null;
  if (args.rtmpTargets) {
    rtmpManager = await setupRtmpTargets(args.rtmpTargets, sharedPipeline);
  }

  const pipeline = runDubbingPipeline({
    input,
    sharedPipeline,
    rtmpManager,
    workDir: path.join(workDir, 'ingest'),
  });
  const { shutdown } = pipeline;

  const app = createServer({ workDir, sharedPipeline, sourceInput: input, pipeline, rtmpManager });
  const server = app.listen(httpPort, () => {
    console.log(`[http] listening on :${httpPort} (GET /languages, POST /select, GET /hls/<lang>/playlist.m3u8)`);
  });

  const onSignal = async (sig) => {
    console.log(`\n[ttsopensource] ${sig} received, stopping…`);
    server.close();
    await shutdown(sig);
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((err) => {
  console.error('\n[ttsopensource] fatal:', err.message);
  if (process.env.DEBUG && err.stack) console.error(err.stack);
  process.exit(1);
});

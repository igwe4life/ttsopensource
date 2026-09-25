#!/usr/bin/env node
// Rewritten for always-on RTMP broadcast (see
// C:\Users\USER\.claude\plans\tranquil-stirring-pixel.md). No browser UI, no
// per-viewer selection — every configured language is generated and pushed
// to its own RTMP destination continuously, for the life of the process.
import { runDubbingPipeline } from './pipeline.js';
import { createServer } from './server.js';
import { config } from './config.js';

const HELP = `
ttsopensource — always-on live speech translation, broadcast to RTMP
  (Whisper/faster-whisper -> NLLB (English pivot) -> Piper/XTTS/MMS-TTS,
  via a GPU inference service's streaming WebSocket — see gpu-service/)

USAGE
  node src/index.js -i <hls-url> [--http-port <port>]

OPTIONS
  --input,    -i <url>     Live HLS URL (master or media playlist)  *required*
  --http-port    <port>    HTTP port for GET /health, /languages (default: ${config.http.port})
  --help,     -h           Show this help

Every language in TARGET_LANGUAGES (see .env.example) starts pushing to
<RTMP_SERVER>/<RTMP_KEY_PREFIX><lang> immediately on startup — there is no
viewer-driven activation. GET /health reports each language's RTMP push
connection state.
`.trim();

function parseArgs(argv) {
  const out = { input: null, httpPort: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-i':
      case '--input':
        out.input = argv[++i];
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('Error: --input is required.\n');
    console.log(HELP);
    process.exit(1);
  }

  const httpPort = args.httpPort || config.http.port;
  const pipeline = runDubbingPipeline({ input: args.input });

  const app = createServer({ sourceInput: args.input, pipeline });
  const server = app.listen(httpPort, () => {
    console.log(`[http] listening on :${httpPort} (GET /health, /languages)`);
  });

  const onSignal = async (sig) => {
    console.log(`\n[ttsopensource] ${sig} received, stopping…`);
    server.close();
    await pipeline.shutdown();
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

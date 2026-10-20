// usage: node cpu_patch.cjs <nLanguages> <relay true|false>
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const SP = __dirname;
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const RUNPOD_KEY = get('RUNPOD_API_KEY'), GPU_KEY = get('GPU_SERVICE_API_KEY');
const rtmpServer = (fs.readFileSync(REPO + '/orchestrator/.env', 'utf8').match(/^RTMP_SERVER=(.*)$/m) || [])[1].trim();
const pods = JSON.parse(fs.readFileSync(SP + '/pool_pods.json', 'utf8'));
const langs = JSON.parse(fs.readFileSync(process.env.POOL_FILE || (REPO + '/language-registry/pool-languages.json'), 'utf8')).languages.slice(0, Number(process.argv[2]));
const env = { GPU_SERVICE_API_KEY: GPU_KEY, GPU_POOL: pods.map((p) => `https://${p.id}-8000.proxy.runpod.net`).join(','),
  STREAM_URL: process.env.STREAM_URL,
  TARGET_LANGUAGES: langs.join(','), RTMP_SERVER: rtmpServer, RTMP_KEY_PREFIX: 'pool-test-', RTMP_STREAM_KEYS: '',
  SOURCE_RELAY: process.argv[3], CHUNK_SECONDS: '4', CHUNK_OVERLAP_MS: '750', CHUNK_TIMEOUT_MS: '15000', MIX_SAMPLE_RATE: '24000', MIX_MAX_QUEUED_SECONDS: '8', DUCK_LEVEL: '0.2', HTTP_PORT: '4000' };
(async () => {
  const id = fs.readFileSync(SP + '/cpu_pool_pod.txt', 'utf8').trim();
  const r = await fetch(`https://rest.runpod.io/v1/pods/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RUNPOD_KEY}` }, body: JSON.stringify({ env }) });
  console.log(`PATCH cpu pod -> HTTP ${r.status} | ${langs.length} languages | relay=${process.argv[3]}`);
})();

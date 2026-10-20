// usage: node repatch_pool.cjs <imageTag> [extraEnvJson]
// Points every pool pod at ghcr.io/igwe4life/ttsopensource-gpu:<imageTag> and rewrites its env
// (including its PRELOAD shard from the CURRENT pool-languages.json). PATCH restarts the pod.
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const SP = __dirname;
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const RUNPOD_KEY = get('RUNPOD_API_KEY');
const GPU_KEY = get('GPU_SERVICE_API_KEY');
const tag = process.argv[2];
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const langs = JSON.parse(fs.readFileSync(process.env.POOL_FILE || (REPO + '/language-registry/pool-languages.json'), 'utf8')).languages;
const pods = JSON.parse(fs.readFileSync(SP + '/pool_pods.json', 'utf8'));
const n = pods.length;
const shards = Array.from({ length: n }, () => []);
langs.forEach((l, i) => shards[i % n].push(l));

(async () => {
  for (const [i, p] of pods.entries()) {
    const body = {
      imageName: `ghcr.io/igwe4life/ttsopensource-gpu:${tag}`,
      env: {
        DEVICE: 'cuda', GPU_PROVIDER: 'runpod', GPU_SERVICE_API_KEY: GPU_KEY,
        PRELOAD_LANGUAGES: shards[i].join(','), PRELOAD_CONCURRENCY: '6',
        MAX_LOADED_TTS_MODELS: '80', NLLB_MAX_BATCH: '64',
        PIPER_VOICES_DIR: '/root/.cache/huggingface/piper',
        ...extra,
      },
    };
    const r = await fetch(`https://rest.runpod.io/v1/pods/${p.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RUNPOD_KEY}` }, body: JSON.stringify(body),
    });
    console.log(`pod ${i} ${p.id}: PATCH -> HTTP ${r.status} | shard ${shards[i].length} languages | extra env: ${Object.keys(extra).join(',') || 'none'}`);
    p.shard = shards[i];
  }
  fs.writeFileSync(SP + '/pool_pods.json', JSON.stringify(pods));
})();

const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const SP = __dirname;
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const RUNPOD_KEY = get('RUNPOD_API_KEY'), GPU_KEY = get('GPU_SERVICE_API_KEY');
const orch = fs.readFileSync(REPO + '/orchestrator/.env', 'utf8');
const rtmpServer = (orch.match(/^RTMP_SERVER=(.*)$/m) || [])[1].trim();
const pods = JSON.parse(fs.readFileSync(SP + '/pool_pods.json', 'utf8'));
const langs = JSON.parse(fs.readFileSync(process.env.POOL_FILE || (REPO + '/language-registry/pool-languages.json'), 'utf8')).languages;
const env = {
  GPU_SERVICE_API_KEY: GPU_KEY, GPU_POOL: pods.map((p) => `https://${p.id}-8000.proxy.runpod.net`).join(','),
  // each pod's own language list, so a language always goes to the pod that holds its voice
  GPU_SHARDS: pods.map((p) => (p.shard || []).join(',')).join('|'),
  STREAM_URL: process.env.STREAM_URL,
  TARGET_LANGUAGES: langs.join(','),
  PUSH_LANGUAGES: process.env.PUSH_FILE ? JSON.parse(fs.readFileSync(process.env.PUSH_FILE, 'utf8')).languages.join(',') : '', RTMP_SERVER: rtmpServer, RTMP_KEY_PREFIX: process.env.KEY_PREFIX || 'pool-test-', RTMP_STREAM_KEYS: process.env.REAL_KEYS === '1' ? ((orch.match(/^RTMP_STREAM_KEYS=(.*)$/m) || [, ''])[1].trim()) : '',
  SOURCE_RELAY: 'true', CHUNK_SECONDS: '4', CHUNK_OVERLAP_MS: '750', CHUNK_TIMEOUT_MS: '15000',
  MIX_SAMPLE_RATE: '24000', MIX_MAX_QUEUED_SECONDS: '8', DUCK_LEVEL: '0.2', HTTP_PORT: '4000',
};
const body = { name: process.env.POD_NAME || 'ttsopensource-orchestrator-pool', imageName: 'ghcr.io/igwe4life/ttsopensource-orchestrator:latest', computeType: 'CPU', cpuFlavorIds: ['cpu3c', 'cpu5c', 'cpu3g', 'cpu5g'], cpuFlavorPriority: 'custom', vcpuCount: 8, cloudType: 'SECURE', containerDiskInGb: 20, volumeInGb: 0, ports: ['4000/http'], env };
(async () => {
  for (let a = 1; a <= 15; a++) {
    const out = await (await fetch('https://rest.runpod.io/v1/pods', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RUNPOD_KEY}` }, body: JSON.stringify(body) })).json();
    if (out.id) { console.log(`cpu pod ${out.id} $${out.costPerHr}/hr vcpu ${out.vcpuCount} mem ${out.memoryInGb}GB | ${langs.length} languages, ${pods.length} gpu nodes, prefix ${env.RTMP_KEY_PREFIX}`); fs.writeFileSync(SP + '/cpu_pool_pod.txt', out.id); return; }
    console.log('attempt', a, String(out.error || JSON.stringify(out)).slice(0, 90)); await new Promise((r) => setTimeout(r, 6000));
  }
})();

// usage: node add_extra_pod.cjs <imageTag> <languagesFile.json>
// Adds ONE more GPU pod that holds exactly the languages listed in the file (e.g. the second batch of 25),
// registers it in pool_pods.json immediately after it is created, and leaves the existing pods untouched.
// Uses the shared model network volume when GPU capacity there allows, else a local volume.
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const SP = __dirname;
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const RUNPOD_KEY = get('RUNPOD_API_KEY'), GPU_KEY = get('GPU_SERVICE_API_KEY');
const tag = process.argv[2];
const langs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).languages;
const volume = JSON.parse(fs.readFileSync(SP + '/model_volume.json', 'utf8'));
const call = (method, path, body) => fetch('https://rest.runpod.io/v1' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RUNPOD_KEY}` }, body: body && JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pods = JSON.parse(fs.readFileSync(SP + '/pool_pods.json', 'utf8'));
  const i = pods.length;
  const base = {
    name: `ttsopensource-prod-gpu-${i}`, imageName: `ghcr.io/igwe4life/ttsopensource-gpu:${tag}`,
    gpuTypeIds: ['NVIDIA GeForce RTX 3090'], gpuTypePriority: 'custom', gpuCount: 1, cloudType: 'SECURE', containerDiskInGb: 50, ports: ['8000/http'],
    env: { DEVICE: 'cuda', GPU_PROVIDER: 'runpod', GPU_SERVICE_API_KEY: GPU_KEY, PRELOAD_LANGUAGES: langs.join(','), PRELOAD_CONCURRENCY: '6', MAX_LOADED_TTS_MODELS: '80', NLLB_MAX_BATCH: '64', PIPER_VOICES_DIR: '/root/.cache/huggingface/piper', TTS_WORKER_PROCS: '12', PIPER_USE_CUDA: 'false', PIPER_CPU_THREADS: '2' },
  };
  const withVol = { ...base, networkVolumeId: volume.volumeId, volumeMountPath: '/root/.cache/huggingface', dataCenterIds: [volume.dc], dataCenterPriority: 'custom' };
  const localVol = { ...base, volumeInGb: 40, volumeMountPath: '/root/.cache/huggingface' };
  for (let a = 1; a <= 60; a++) {
    for (const [label, body] of [['network volume', withVol], ['local volume', localVol]]) {
      const out = await (await call('POST', '/pods', body)).json();
      if (out.id) {
        pods.push({ id: out.id, shard: langs, cost: out.costPerHr, vcpu: out.vcpuCount });
        fs.writeFileSync(SP + '/pool_pods.json', JSON.stringify(pods)); // register right away
        console.log(`pod ${i}: ${out.id} $${out.costPerHr}/hr vcpu ${out.vcpuCount} dc ${out.machine && out.machine.dataCenterId} (${label}), ${langs.length} languages`);
        return;
      }
      if (a % 6 === 1) console.log(`attempt ${a} (${label}): ${String(out.error || JSON.stringify(out)).slice(0, 80)}`);
    }
    await sleep(10000);
  }
  console.log('could not allocate a GPU after 60 attempts; nothing was created');
})();

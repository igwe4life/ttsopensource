// usage: node scale_pool.cjs <imageTag> <targetPods>
// Adds RTX 3090 pods until pool_pods.json has <targetPods>, each with its N-way shard + preload env.
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const SP = __dirname;
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const RUNPOD_KEY = get('RUNPOD_API_KEY'), GPU_KEY = get('GPU_SERVICE_API_KEY');
const tag = process.argv[2], target = Number(process.argv[3]);
const langs = JSON.parse(fs.readFileSync(process.env.POOL_FILE || (REPO + '/language-registry/pool-languages.json'), 'utf8')).languages;
const pods = JSON.parse(fs.readFileSync(SP + '/pool_pods.json', 'utf8'));
const shards = Array.from({ length: target }, () => []); langs.forEach((l, i) => shards[i % target].push(l));
const call = (method, path, body) => fetch('https://rest.runpod.io/v1' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RUNPOD_KEY}` }, body: body && JSON.stringify(body) });
(async () => {
  // ONLY_PODS=1 creates just the first pod of the <targetPods>-way split (single-pod tests).
  while (pods.length < Math.min(target, Number(process.env.ONLY_PODS || target))) {
    const i = pods.length;
    const body = { name: `ttsopensource-prod-gpu-${i}`, imageName: `ghcr.io/igwe4life/ttsopensource-gpu:${tag}`, gpuTypeIds: (process.env.GPU_TYPES || 'NVIDIA GeForce RTX 3090').split(','), gpuTypePriority: 'custom', gpuCount: 1, cloudType: 'SECURE',
      containerDiskInGb: 50, ports: ['8000/http'],
      // Prefer the shared network volume (models already downloaded -> ~1-2 min start); it pins pods to its datacenter.
      ...(process.env.NETWORK_VOLUME_ID
        ? { networkVolumeId: process.env.NETWORK_VOLUME_ID, volumeMountPath: '/root/.cache/huggingface', dataCenterIds: [process.env.NETWORK_VOLUME_DC || 'EU-CZ-1'], dataCenterPriority: 'custom' }
        : { volumeInGb: 40, volumeMountPath: '/root/.cache/huggingface' }),
      env: { DEVICE: 'cuda', GPU_PROVIDER: 'runpod', GPU_SERVICE_API_KEY: GPU_KEY, PRELOAD_LANGUAGES: shards[i].join(','), PRELOAD_CONCURRENCY: '6', MAX_LOADED_TTS_MODELS: '80', NLLB_MAX_BATCH: '64', PIPER_VOICES_DIR: '/root/.cache/huggingface/piper', TTS_WORKER_PROCS: '12', PIPER_USE_CUDA: 'false', PIPER_CPU_THREADS: '2', ...(process.env.EXTRA_ENV ? JSON.parse(process.env.EXTRA_ENV) : {}) } };
    let landed = null;
    for (let a = 1; a <= 12 && !landed; a++) {
      const out = await (await call('POST', '/pods', body)).json();
      if (out.id) { if (out.costPerHr <= 0.6 && (out.vcpuCount || 0) >= Number(process.env.MIN_VCPU || 0)) landed = out; else { console.log(`pod ${i}: landed ${out.machine && out.machine.gpuTypeId} ${out.costPerHr} ${out.vcpuCount}vCPU - rejected (price cap / min vCPU), deleting`); await call('DELETE', '/pods/' + out.id); } }
      if (!landed) await new Promise((r) => setTimeout(r, 8000));
    }
    if (!landed) { console.log(`pod ${i}: could not allocate`); break; }
    console.log(`pod ${i}: ${landed.id} $${landed.costPerHr}/hr vcpu ${landed.vcpuCount} dc ${landed.machine && landed.machine.dataCenterId}`);
    pods.push({ id: landed.id, shard: shards[i], cost: landed.costPerHr, vcpu: landed.vcpuCount });
  }
  fs.writeFileSync(SP + '/pool_pods.json', JSON.stringify(pods));
  console.log('pool size now', pods.length);
})();

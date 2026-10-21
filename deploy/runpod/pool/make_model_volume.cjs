// Creates a RunPod NETWORK volume holding the downloaded models (Whisper, NLLB, every Piper/MMS
// voice of the language set), so new GPU pods that mount it start in ~1-2 minutes instead of
// spending 5-7 minutes downloading from Hugging Face.
//
// usage: node make_model_volume.cjs <gpu-image-tag> [sizeGb=40] [dataCenter=EU-CZ-1]
// env:   POOL_FILE  language list (defaults to language-registry/pool-50.json)
//
// 1. creates the volume (if NETWORK_VOLUME_ID is not given),
// 2. runs ONE temporary RTX 3090 pod with the volume mounted at /root/.cache/huggingface and
//    PRELOAD_LANGUAGES = the full list, so the service downloads everything onto the volume,
// 3. waits for the preload to finish, then deletes the temporary pod (the volume stays).
//
// A network volume belongs to one datacenter, so pods that mount it are pinned to that datacenter.
// Cost: ~$0.07/GB/month while it exists.
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const KEY = get('RUNPOD_API_KEY'), GPU_KEY = get('GPU_SERVICE_API_KEY');
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };
const tag = process.argv[2], sizeGb = Number(process.argv[3] || 40), dc = process.argv[4] || 'EU-CZ-1';
const langs = JSON.parse(fs.readFileSync(process.env.POOL_FILE || (REPO + '/language-registry/pool-50.json'), 'utf8')).languages;
const api = async (method, path, body) => {
  const r = await fetch('https://rest.runpod.io/v1' + path, { method, headers: H, body: body && JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { ok: r.ok, status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let volumeId = process.env.NETWORK_VOLUME_ID;
  if (!volumeId) {
    const v = await api('POST', '/networkvolumes', { name: 'ttsopensource-models', size: sizeGb, dataCenterId: dc });
    if (!v.ok) { console.log('could not create the volume:', v.status, JSON.stringify(v.json).slice(0, 300)); process.exit(1); }
    volumeId = v.json.id; console.log(`network volume ${volumeId}: ${v.json.size}GB in ${v.json.dataCenterId}`);
  }
  const body = {
    name: 'ttsopensource-volume-filler', imageName: `ghcr.io/igwe4life/ttsopensource-gpu:${tag}`,
    gpuTypeIds: ['NVIDIA GeForce RTX 3090', 'NVIDIA RTX A5000'], gpuTypePriority: 'custom', gpuCount: 1, cloudType: 'SECURE',
    dataCenterIds: [dc], dataCenterPriority: 'custom', containerDiskInGb: 50,
    networkVolumeId: volumeId, volumeMountPath: '/root/.cache/huggingface', ports: ['8000/http'],
    env: { DEVICE: 'cuda', GPU_PROVIDER: 'runpod', GPU_SERVICE_API_KEY: GPU_KEY, PRELOAD_LANGUAGES: langs.join(','),
      PRELOAD_CONCURRENCY: '6', MAX_LOADED_TTS_MODELS: '80', NLLB_MAX_BATCH: '64',
      PIPER_VOICES_DIR: '/root/.cache/huggingface/piper', TTS_WORKER_PROCS: '12', PIPER_USE_CUDA: 'false', PIPER_CPU_THREADS: '2' },
  };
  let pod = null;
  for (let a = 1; a <= 40 && !pod; a++) {
    const r = await api('POST', '/pods', body);
    if (r.ok && r.json.id) pod = r.json; else { if (a % 5 === 1) console.log('allocation attempt', a, String(r.json.error || JSON.stringify(r.json)).slice(0, 90)); await sleep(8000); }
  }
  if (!pod) { console.log('could not allocate a GPU in ' + dc + '; the volume exists (' + volumeId + ')'); process.exit(1); }
  console.log(`filler pod ${pod.id} (${pod.machine && pod.machine.gpuTypeId}) $${pod.costPerHr}/hr in ${pod.machine && pod.machine.dataCenterId}`);
  fs.writeFileSync(__dirname + '/model_volume.json', JSON.stringify({ volumeId, dc, sizeGb, fillerPod: pod.id }));

  const url = `https://${pod.id}-8000.proxy.runpod.net/health`;
  for (let i = 0; i < 120; i++) {   // up to ~30 min
    await sleep(15000);
    try {
      const h = await (await fetch(url, { headers: { 'x-api-key': GPU_KEY }, signal: AbortSignal.timeout(8000) })).json();
      const w = h.models && h.models.tts_workers;
      if (i % 4 === 0) console.log(`preload ${h.preload.done}/${h.preload.total} ready=${h.preload.ready} failed=${Object.keys(h.preload.failed || {}).length}`);
      if (h.preload.ready && w && w.ready && h.preload.total === langs.length && h.preload.done === langs.length) {
        console.log(`volume filled: ${h.preload.done}/${h.preload.total} voices loaded, failed=${JSON.stringify(h.preload.failed)}`); break;
      }
    } catch { /* pod still starting */ }
  }
  const del = await api('DELETE', '/pods/' + pod.id);
  console.log('deleted filler pod ->', del.status, '| volume kept:', volumeId);
})();

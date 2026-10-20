const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const envText = fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8');
const KEY = (envText.match(/^GPU_SERVICE_API_KEY=(.*)$/m) || [])[1].trim();
const pods = JSON.parse(fs.readFileSync(__dirname + '/pool_pods.json', 'utf8'));
const maxMin = Number(process.argv[2] || 9);
(async () => {
  const deadline = Date.now() + maxMin * 60000;
  let last = '';
  while (Date.now() < deadline) {
    const rows = await Promise.all(pods.map(async (p, i) => {
      try {
        const r = await fetch(`https://${p.id}-8000.proxy.runpod.net/health`, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return `pod${i}: HTTP ${r.status}`;
        const h = await r.json();
        const pl = h.preload || {};
        return `pod${i}: up ${(h.gpu.gpu_name||"").replace("NVIDIA GeForce ","")} preload ${pl.done}/${pl.total} ready=${pl.ready} failed=${Object.keys(pl.failed || {}).length} vram_free=${h.gpu.vram_free_gb}GB`;
      } catch (e) { return `pod${i}: unreachable`; }
    }));
    const line = rows.join(' | ');
    if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line; }
    if (rows.every((r) => /ready=true/.test(r))) { console.log('ALL READY'); return; }
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log('timeout waiting');
})();

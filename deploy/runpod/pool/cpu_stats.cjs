const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const POD = fs.readFileSync(__dirname + '/cpu_pool_pod.txt', 'utf8').trim();
const RUNPOD_KEY = (fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8').match(/^RUNPOD_API_KEY=(.*)$/m) || [])[1].trim();
(async () => {
  let h; try { h = await (await fetch(`https://${POD}-4000.proxy.runpod.net/health`, { signal: AbortSignal.timeout(10000) })).json(); } catch (e) { console.log('health unreachable'); return; }
  const s = h.source || {};
  console.log('pushers', JSON.stringify(s.pushers), '| relay', JSON.stringify(s.relay), '| gpuNodes', JSON.stringify(s.gpuNodes));
  console.log('stats', JSON.stringify(s.stats));
  const fl = s.failedLanguages || {}; console.log('failedLanguages:', Object.keys(fl).length);
  const g = await (await fetch(`https://api.runpod.io/graphql?api_key=${RUNPOD_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query { myself { clientBalance pods { id runtime { container { cpuPercent memoryPercent } } } } }' }) })).json();
  const p = g.data.myself.pods.find((x) => x.id === POD);
  console.log('cpu pod: cpu', p?.runtime?.container?.cpuPercent + '% of ONE core (16 available) mem', p?.runtime?.container?.memoryPercent + '% | balance $' + g.data.myself.clientBalance.toFixed(2));
})();

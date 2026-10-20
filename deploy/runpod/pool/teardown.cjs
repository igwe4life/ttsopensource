const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..', '..', '..');
const RUNPOD_KEY = (fs.readFileSync(REPO + '/deploy/runpod/.env', 'utf8').match(/^RUNPOD_API_KEY=(.*)$/m) || [])[1].trim();
const ids = [fs.readFileSync(__dirname + '/cpu_pool_pod.txt', 'utf8').trim(), ...JSON.parse(fs.readFileSync(__dirname + '/pool_pods.json', 'utf8')).map((p) => p.id)];
(async () => {
  for (const id of ids) { const r = await fetch(`https://rest.runpod.io/v1/pods/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${RUNPOD_KEY}` } }); console.log('delete', id, '->', r.status); }
  await new Promise((r) => setTimeout(r, 4000));
  const g = await (await fetch(`https://api.runpod.io/graphql?api_key=${RUNPOD_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query { myself { clientBalance pods { id name costPerHr } } }' }) })).json();
  const m = g.data.myself; console.log('balance $' + m.clientBalance.toFixed(2), '| remaining pods:', m.pods.map((p) => `${p.name} $${p.costPerHr}`).join(', '), '| burn $' + m.pods.reduce((a, p) => a + p.costPerHr, 0).toFixed(2) + '/hr');
})();

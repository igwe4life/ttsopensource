const fs = require('fs');
const raw = fs.readFileSync('C:/ttsopensource/orchestrator/.env', 'utf8').split(/\r?\n/);
const keep = ['GPU_SERVICE_URL','GPU_SERVICE_WS_URL','GPU_SERVICE_API_KEY','CHUNK_SECONDS','CHUNK_OVERLAP_MS','CHUNK_TIMEOUT_MS','MIX_SAMPLE_RATE','MIX_MAX_QUEUED_SECONDS','DUCK_LEVEL','RTMP_SERVER'];
const env = {};
for (const l of raw) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && keep.includes(m[1]) && m[2].trim()) env[m[1]] = m[2].trim(); }
env.STREAM_URL = 'https://pvqybrzodz24-hls-live.5centscdn.com/HSOP/955ad3298db330b5ee880c2c9e6f23a0.sdp/playlist.m3u8';
env.TARGET_LANGUAGES = 'es,fr,de';
env.RTMP_KEY_PREFIX = 'cpu-test-';
env.RTMP_STREAM_KEYS = '';
env.HTTP_PORT = '4000';
fs.writeFileSync('_env.json', JSON.stringify(env));
console.log('env keys:', Object.keys(env).join(','));

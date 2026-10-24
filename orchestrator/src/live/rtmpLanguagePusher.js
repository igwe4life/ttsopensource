import { spawn } from 'node:child_process';

function ffmpegBinary() {
  // Read lazily, not at module load — see audioCapture.js's identical
  // comment on why (dotenv/config import-order fragility).
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * One persistent ffmpeg per language: pulls the source's video + original
 * audio directly (no -re — this is a genuine live network source, which
 * paces itself naturally over HTTP, same as audioCapture.js's capture),
 * mixes in that language's live translated-audio pipe (fed by
 * liveAudioMixer.js) via amix, and pushes the result to one RTMP
 * destination. No time-stretching, no pre-muxed segment files — both inputs
 * are continuous real-time streams for as long as this process runs.
 *
 * The reconnect/buffer-while-restarting/swallow-stdin-EPIPE pattern here is
 * adapted from the old (deleted) rtmpPush.js — same resilience shape, but
 * this pusher's ffmpeg has TWO inputs (source URL + translated-audio pipe)
 * and a mixing filter graph, instead of one pre-muxed stdin with `-c copy`.
 *
 * @param {object} opts
 * @param {string} opts.sourceUrl   live HLS source (video + original audio)
 * @param {string} opts.rtmpUrl     e.g. rtmp://web.homestream.live/live/es
 * @param {number} opts.sampleRate  must match liveAudioMixer's sampleRate
 * @param {number} [opts.duckLevel] original-audio volume under the dub (0-1)
 */
// About 20 s of the 24 kHz mono 16-bit translated-audio pipe.
const MAX_BUFFERED_BYTES = 1024 * 1024;

const STALL_MS = 45000;

export function createRtmpLanguagePusher({ sourceUrl, rtmpUrl, sampleRate, duckLevel = 0.2 }) {
  const state = {
    process: null,
    stdin: null,
    pending: [],
    pendingBytes: 0,
    droppedBytes: 0,
    closed: false,
    reconnecting: false,
    reconnectAttempts: 0,
  };

  function start() {
    if (state.closed) return;
    const startedAt = Date.now();
    const args = [
      '-hide_banner',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '4',
      '-i', sourceUrl,
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1',
      '-i', 'pipe:0',
      '-filter_complex',
      `[0:a]volume=${duckLevel.toFixed(2)}[orig];[1:a]volume=1.0[dub];[orig][dub]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      // Passthrough video alongside a FILTERED audio path can starve
      // ffmpeg's default packet buffer if the filter graph is ever
      // momentarily behind (e.g. the translated-audio pipe had a brief
      // gap) — found via live testing as choppy video playback. A larger
      // muxing queue gives video packets somewhere to wait instead of
      // being dropped/stalled.
      '-max_muxing_queue_size', '1024',
      '-f', 'flv',
      rtmpUrl,
    ];

    const proc = spawn(ffmpegBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    state.process = proc;
    state.stdin = proc.stdin;

    // Same reasoning as rtmpPush.js originally: without this, an EPIPE on
    // write() after the RTMP connection drops crashes the whole process.
    proc.stdin.on('error', (err) => {
      console.warn(`[rtmpPusher:${rtmpUrl}] stdin error (ignored, will reconnect): ${err.code || err.message}`);
    });

    // Watchdog: ffmpeg prints "time=HH:MM:SS.xx" progress. If the output clock stops advancing for STALL_MS
    // the process is wedged (blocked input or a dead RTMP connection that never errors) and viewers see a frozen
    // stream; kill it so it is restarted. A grace period covers startup.
    let stderrTail = '';
    let lastAdvanceAt = Date.now() + 30000;
    let lastTime = '';
    const watchdog = setInterval(() => {
      if (Date.now() - lastAdvanceAt > STALL_MS) {
        clearInterval(watchdog);
        console.warn(`[rtmpPusher:${rtmpUrl}] output stalled for ${Math.round((Date.now() - lastAdvanceAt) / 1000)}s; restarting`);
        proc.kill('SIGKILL');
      }
    }, 5000);
    proc.on('close', () => clearInterval(watchdog));
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      const m = [...text.matchAll(/time=(d+:d+:d+.d+)/g)].pop();
      if (m && m[1] !== lastTime) { lastTime = m[1]; lastAdvanceAt = Date.now(); }
    });

    // Covers a spawn-level failure (e.g. missing ffmpeg binary) — 'exit'
    // alone would miss this, same gap fixed in audioCapture.js earlier.
    proc.on('error', (err) => {
      console.error(`[rtmpPusher:${rtmpUrl}] spawn error: ${err.message}`);
      scheduleReconnect(startedAt);
    });

    proc.on('exit', (code, signal) => {
      state.process = null;
      state.stdin = null;
      if (state.closed) return;
      console.warn(`[rtmpPusher:${rtmpUrl}] ffmpeg exited (code=${code} signal=${signal}); stderr tail: ${stderrTail.slice(-300)}`);
      scheduleReconnect(startedAt);
    });

    flushPending();
  }

  function scheduleReconnect(startedAt) {
    if (state.closed || state.reconnecting) return;
    state.reconnecting = true;
    const ranFor = Date.now() - startedAt;
    state.reconnectAttempts = ranFor > 30000 ? 1 : state.reconnectAttempts + 1;
    const backoff = Math.min(2000 * 2 ** state.reconnectAttempts, 15000);
    setTimeout(() => {
      state.reconnecting = false;
      start();
    }, backoff);
  }

  function keepPending(chunk) {
    state.pending.push(chunk);
    state.pendingBytes += chunk.length;
    while (state.pendingBytes > MAX_BUFFERED_BYTES && state.pending.length > 1) {
      state.pendingBytes -= state.pending.shift().length; // oldest audio is the least useful
    }
  }

  function flushPending() {
    if (state.pending.length === 0 || !state.stdin || state.stdin.destroyed) return;
    const combined = Buffer.concat(state.pending.splice(0));
    state.pendingBytes = 0;
    state.stdin.write(combined, (err) => {
      if (err) { state.pending.unshift(combined); state.pendingBytes = combined.length; }
    });
  }

  start();

  return {
    /** Feed raw translated-audio PCM bytes (see liveAudioMixer.js's pump). */
    write(chunk) {
      if (state.closed) return;
      if (!state.stdin || state.stdin.destroyed || state.reconnecting) {
        keepPending(chunk);
        return;
      }
      // This is real-time audio: if ffmpeg is not reading (its RTMP output is slow or
      // stalled), data queued for it only grows memory and plays late. Drop instead of
      // buffering without limit (this exact growth took the orchestrator to 60%+ of RAM).
      if (state.stdin.writableLength > MAX_BUFFERED_BYTES) {
        state.droppedBytes += chunk.length;
        return;
      }
      state.stdin.write(chunk, (err) => {
        if (err) keepPending(chunk);
      });
    },
    stop() {
      state.closed = true;
      state.process?.kill('SIGTERM');
    },
    get alive() {
      return !!state.process;
    },
    get bufferedBytes() {
      return (state.stdin ? state.stdin.writableLength : 0) + state.pendingBytes;
    },
    get droppedBytes() {
      return state.droppedBytes;
    },
    get reconnecting() {
      return state.reconnecting;
    },
  };
}

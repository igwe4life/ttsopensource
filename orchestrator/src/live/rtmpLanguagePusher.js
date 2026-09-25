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
export function createRtmpLanguagePusher({ sourceUrl, rtmpUrl, sampleRate, duckLevel = 0.2 }) {
  const state = {
    process: null,
    stdin: null,
    pending: [],
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

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
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

  function flushPending() {
    if (state.pending.length === 0 || !state.stdin || state.stdin.destroyed) return;
    const combined = Buffer.concat(state.pending.splice(0));
    state.stdin.write(combined, (err) => {
      if (err) state.pending.unshift(combined);
    });
  }

  start();

  return {
    /** Feed raw translated-audio PCM bytes (see liveAudioMixer.js's pump). */
    write(chunk) {
      if (state.closed) return;
      if (!state.stdin || state.stdin.destroyed || state.reconnecting) {
        state.pending.push(chunk);
        return;
      }
      state.stdin.write(chunk, (err) => {
        if (err) state.pending.push(chunk);
      });
    },
    stop() {
      state.closed = true;
      state.process?.kill('SIGTERM');
    },
    get alive() {
      return !!state.process;
    },
    get reconnecting() {
      return state.reconnecting;
    },
  };
}

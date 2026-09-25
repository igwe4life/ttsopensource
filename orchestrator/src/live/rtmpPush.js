// Reused verbatim from ttsengine/src/live/rtmpPush.js — this is generic
// long-running-ffmpeg-over-stdin RTMP push, no Azure/proprietary dependency,
// so nothing needed to change. Used by rtmpOutputManager.js, which is new:
// one of these per language that has a configured RTMP target (see
// rtmp-targets.json.example), matching the old engine's "one RTMP stream key
// per language" model.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Long-running RTMP pusher.
 *
 * Spawns one ffmpeg that reads a continuous MPEG-TS stream from stdin and
 * pushes it to an RTMP endpoint (e.g. obs1.homestream.live). Because every
 * remuxed segment shares identical codec params (copied H.264 video + AAC 48k
 * stereo), the concatenated .ts bytes form one continuous stream that ffmpeg
 * remuxes to FLV/RTMP with `-c copy` (no re-encode).
 *
 * Robustness:
 *   - Writes are buffered if ffmpeg is (re)starting; flushed on reconnect.
 *   - stdin stream errors (broken pipe when RTMP drops) are CAUGHT and trigger
 *     a respawn rather than crashing the process.
 *   - Exponential-backoff reconnect with a cap.
 *
 * The returned object exposes:
 *   - `write(chunk)`  feed remuxed .ts bytes (Buffer)
 *   - `end()`         close stdin cleanly (sends EOF → ffmpeg flushes + exits)
 *   - `waitForExit()` resolves on clean exit; rejects on fatal/unrecoverable
 *   - `process`       raw state (for introspection)
 *
 * @param {string} rtmpUrl  e.g. rtmp://obs1.homestream.live/live/FRENCH_109_HS
 * @param {object} [opts]
 * @param {boolean} [opts.reconnect=true]  auto-respawn on unexpected exit
 * @param {object}  [opts.reporter]        admin-telemetry reporter (optional)
 * @returns {Promise<object>} pusher handle (resolves once first ffmpeg started)
 */
export async function createRtmpPusher(rtmpUrl, opts = {}) {
  const { reconnect = true, reporter = null } = opts;

  const state = {
    process: null,
    stdin: null,
    /** Buffer of bytes written while ffmpeg was (re)starting, flushed on start. */
    pending: [],
    closed: false,          // caller called end() — clean shutdown in progress
    fatalError: null,
    exitHandlers: new Set(),
    reconnecting: false,
    reconnectAttempts: 0,
  };

  async function start() {
    // Read TS from stdin, copy codecs to FLV, push RTMP.
    const args = [
      '-hide_banner',
      // -re paces output to realtime (1×). Without it ffmpeg drains the stdin
      // buffer as fast as it can, bursting segments to RTMP and then stalling
      // while the next segment is processed — which causes the player buffer
      // to underrun and produce a noticeable break. With -re, output matches
      // wall-clock so a few seconds of buffered segments absorb processing jitter.
      '-re',
      '-fflags', '+genpts+discardcorrupt',
      '-i', 'pipe:0',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'flv',
      rtmpUrl,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    state.process = proc;
    state.stdin = proc.stdin;

    // CRITICAL: swallow errors on stdin. When the RTMP connection drops, ffmpeg
    // exits and its stdin closes; any subsequent write() then emits 'error' on
    // the pipe. Without this handler Node treats it as an unhandled exception
    // and crashes the whole process. We surface the failure via the proc 'exit'
    // path below, which triggers reconnect.
    proc.stdin.on('error', (err) => {
      console.warn(`[rtmpPush] stdin error (ignored, will reconnect): ${err.code || err.message}`);
    });

    // Log stderr for visibility (ffmpeg prints progress/errors here).
    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) console.debug(`[rtmpPush] ${line}`);
      }
    });

    proc.on('error', (err) => {
      // spawn-level error (e.g. ffmpeg binary missing).
      state.fatalError = err;
      console.error(`[rtmpPush] spawn error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      state.process = null;
      state.stdin = null;
      if (state.closed) {
        // Clean shutdown via end(): expected.
        console.log(`[rtmpPush] ffmpeg exited (code=${code}) after clean close`);
        state.exitHandlers.forEach((h) => h({ intentional: true, code }));
        return;
      }
      // Unexpected exit — the RTMP connection dropped or ffmpeg crashed.
      console.warn(`[rtmpPush] ffmpeg exited unexpectedly (code=${code} signal=${signal})`);
      reporter?.rtmp(false, `code=${code} signal=${signal}`);
      maybeReconnect();
    });

    // Flush any bytes that piled up while we were (re)starting.
    flushPending();
    state.reconnectAttempts = 0;
  }

  function maybeReconnect() {
    if (!reconnect || state.closed || state.fatalError) {
      // Unrecoverable — notify waiters and stop.
      state.exitHandlers.forEach((h) => h({ intentional: false, fatalError: state.fatalError }));
      return;
    }
    if (state.reconnecting) return;
    state.reconnecting = true;
    const backoff = Math.min(2000 * 2 ** state.reconnectAttempts, 15000);
    state.reconnectAttempts++;
    console.log(`[rtmpPush] reconnecting in ${backoff}ms (attempt ${state.reconnectAttempts})…`);
    setTimeout(async () => {
      state.reconnecting = false;
      try {
        await start();
        console.log('[rtmpPush] reconnected; resuming push');
        reporter?.rtmp(true);
      } catch (err) {
        console.error(`[rtmpPush] reconnect failed: ${err.message}`);
        maybeReconnect(); // try again
      }
    }, backoff);
  }

  function flushPending() {
    if (state.pending.length === 0 || !state.stdin || state.stdin.destroyed) return;
    const chunks = state.pending.splice(0);
    const combined = Buffer.concat(chunks);
    state.stdin.write(combined, (err) => {
      if (err) {
        console.warn(`[rtmpPush] flush write error (re-buffering): ${err.code || err.message}`);
        // Put it back at the front to retry on next start.
        state.pending.unshift(combined);
      }
    });
  }

  await start();

  return {
    /** Feed remuxed .ts bytes to ffmpeg's stdin. Never throws; buffers if down. */
    write(chunk) {
      if (state.closed) return;
      if (!state.process || !state.stdin || state.stdin.destroyed || state.reconnecting) {
        // ffmpeg not ready (respawning). Stash and flush on next start.
        state.pending.push(chunk);
        return;
      }
      // write() with a callback so EPIPE/backpressure is handled, not thrown.
      state.stdin.write(chunk, (err) => {
        if (err) {
          console.warn(`[rtmpPush] write error (buffering): ${err.code || err.message}`);
          state.pending.push(chunk);
          // The 'exit'/'error' handlers will trigger reconnect; just ensure we
          // don't lose this chunk.
        }
      });
    },

    /** Cleanly close: flush + send EOF so ffmpeg finalizes the RTMP stream. */
    end() {
      if (state.closed) return;
      state.closed = true;
      flushPending();
      if (state.stdin && !state.stdin.destroyed) {
        state.stdin.end();
      }
    },

    /** Kill immediately (e.g. on SIGINT). */
    kill() {
      state.closed = true;
      state.fatalError = new Error('killed');
      if (state.process) state.process.kill('SIGKILL');
    },

    /** Resolve when ffmpeg exits. `{intentional, code, err}`. */
    waitForExit() {
      return new Promise((resolve) => {
        state.exitHandlers.add(resolve);
      });
    },

    get alive() {
      return !!state.process;
    },

    state,
  };
}

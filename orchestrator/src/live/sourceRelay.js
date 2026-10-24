import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';

const STALE_MS = 45000;
import path from 'node:path';

function ffmpegBinary() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * One shared pull of the live source, re-served locally.
 *
 * Without this, every language's RTMP pusher opens its own connection to the
 * source CDN — at ~100 languages that is ~100 simultaneous pulls of a 1080p
 * stream (~220 Mbit/s) from a CDN that never agreed to serve that many from
 * one client. Here a single ffmpeg pulls the source once (`-c copy`, no
 * re-encode) and writes a short rolling HLS playlist to a local directory; the
 * orchestrator's HTTP server serves that directory at /relay, and each
 * pusher reads http://127.0.0.1:<port>/relay/live.m3u8 instead.
 *
 * Side effect worth knowing: pushers join a few segments behind the relay's
 * live edge, so the video + original audio come out slightly later than they
 * do from a direct pull — which sits closer to when the translated audio
 * arrives, not further from it.
 *
 * @param {object} opts
 * @param {string} opts.sourceUrl  live HLS source
 * @param {string} opts.dir        local directory for the rolling playlist/segments
 */
export function createSourceRelay({ sourceUrl, dir }) {
  const playlist = path.join(dir, 'live.m3u8');
  const state = { process: null, closed: false, reconnectAttempts: 0, reconnecting: false };

  // Start clean: stale segments from a previous run would be served under the
  // same names as new ones.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  function start() {
    if (state.closed) return;
    const startedAt = Date.now();
    const proc = spawn(
      ffmpegBinary(),
      [
        '-hide_banner', '-loglevel', 'warning',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
        '-i', sourceUrl,
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
        '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
        playlist,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    state.process = proc;

    let stderrTail = '';
    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-1500); });
    proc.on('error', (err) => {
      console.error(`[relay] spawn error: ${err.message}`);
      scheduleReconnect(startedAt);
    });
    proc.on('exit', (code, signal) => {
      state.process = null;
      if (state.closed) return;
      console.warn(`[relay] ffmpeg exited (code=${code} signal=${signal}); stderr tail: ${stderrTail.slice(-300)}`);
      scheduleReconnect(startedAt);
    });
  }

  function scheduleReconnect(startedAt) {
    if (state.closed || state.reconnecting) return;
    state.reconnecting = true;
    state.reconnectAttempts = Date.now() - startedAt > 30000 ? 1 : state.reconnectAttempts + 1;
    const backoff = Math.min(1000 * 2 ** state.reconnectAttempts, 10000);
    setTimeout(() => {
      state.reconnecting = false;
      start();
    }, backoff);
  }

  // Watchdog: if the rolling playlist stops being rewritten the relay's ffmpeg is wedged (e.g. the source
  // stream restarted underneath it). Kill it so the exit handler restarts it.
  const watchdog = setInterval(() => {
    if (state.closed || !state.process) return;
    try {
      const age = Date.now() - statSync(playlist).mtimeMs;
      if (age > STALE_MS) {
        console.warn(`[relay] playlist not updated for ${Math.round(age / 1000)}s; restarting relay ffmpeg`);
        state.process.kill('SIGKILL');
      }
    } catch { /* playlist not written yet */ }
  }, 10000);

  start();

  return {
    dir,
    /** Resolves once the playlist lists at least 3 segments (enough for a player to start). */
    ready(timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          try {
            if (existsSync(playlist)) {
              const segs = readFileSync(playlist, 'utf8').split('\n').filter((l) => l.endsWith('.ts')).length;
              if (segs >= 3) return resolve();
            }
          } catch { /* playlist mid-write — try again */ }
          if (Date.now() > deadline) return reject(new Error('source relay did not produce a playlist in time'));
          setTimeout(tick, 500);
        };
        tick();
      });
    },
    stop() {
      clearInterval(watchdog);
      state.closed = true;
      state.process?.kill('SIGTERM');
    },
    get alive() {
      return !!state.process;
    },
    get segments() {
      try {
        return readdirSync(dir).filter((f) => f.endsWith('.ts')).length;
      } catch {
        return 0;
      }
    },
  };
}

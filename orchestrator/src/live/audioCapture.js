import { spawn } from 'node:child_process';

// Read lazily (inside start(), not at module load) — this module can be
// imported before dotenv/config has populated process.env, depending on
// import order elsewhere, and a top-level read would freeze in the wrong
// value permanently.
function ffmpegBinary() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * Captures a live HLS source's audio as a CONTINUOUS raw PCM stream — no
 * segment files, no disk writes, no video handling (video playback is the
 * browser's own job: it points hls.js straight at the source URL). This
 * replaces the old playlistPoller.js + extractAudio.js pair, which downloaded
 * each ~10s .ts to disk and spawned a fresh ffmpeg per segment.
 *
 * A single long-running ffmpeg process is used deliberately (not fluent-
 * ffmpeg's `runFfmpeg`, which is a one-shot wrapper that resolves on 'end' —
 * unusable for a stream with no natural end). ffmpeg's own `-reconnect`
 * flags handle transient network blips on the SOURCE fetch; this module
 * additionally restarts the whole process with backoff if it exits
 * unexpectedly (e.g. the source going away entirely), mirroring the
 * resilience the old pipeline had for its initial connection, but now
 * covering the whole run, not just startup.
 *
 * @param {string} hlsUrl live HLS source (master or media playlist)
 * @param {(chunk: Buffer) => void} onData called with raw PCM bytes
 *   (16-bit little-endian, mono, 16kHz) as they arrive
 * @param {(err: Error) => void} [onError] called on a restart-worthy failure
 * @returns {{ stop: () => void }}
 */
export function captureAudio(hlsUrl, onData, onError = () => {}) {
  let stopped = false;
  let attempt = 0;
  let child = null;

  function start() {
    if (stopped) return;
    const startedAt = Date.now();
    let handled = false; // 'error' and 'exit' can both fire for one failed spawn — restart only once

    function restart(reason) {
      if (handled || stopped) return;
      handled = true;
      // Only treat this as "recovered" (reset backoff) if the process
      // actually ran for a while — a process that fails to spawn at all, or
      // exits immediately (bad URL, missing binary), must still back off
      // increasingly, or this becomes a tight crash loop.
      const ranFor = Date.now() - startedAt;
      attempt = ranFor > 30000 ? 1 : attempt + 1;
      const backoff = Math.min(1000 * 2 ** attempt, 15000);
      onError(new Error(reason));
      setTimeout(start, backoff);
    }

    child = spawn(ffmpegBinary(), [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '4',
      '-i', hlsUrl,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      'pipe:1',
    ]);

    // A spawn failure (e.g. ffmpeg binary not found) emits 'error', not
    // 'exit' — without this handler Node treats it as an unhandled error
    // event and crashes the whole process. Found via live testing.
    child.on('error', (err) => restart(`ffmpeg capture failed to start: ${err.message}`));

    child.stdout?.on('data', onData);

    let stderrTail = '';
    child.stderr?.on('data', (buf) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000);
    });

    child.on('exit', (code, signal) => {
      restart(`ffmpeg capture exited (code=${code} signal=${signal}); stderr tail: ${stderrTail.slice(-300)}`);
    });
  }

  start();

  return {
    stop() {
      stopped = true;
      child?.kill('SIGTERM');
    },
  };
}

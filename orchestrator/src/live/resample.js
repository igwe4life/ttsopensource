import { spawn } from 'node:child_process';

function ffmpegBinary() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * Converts a WAV buffer (gpu-service's TTS output, whatever the engine's
 * native sample rate is — Piper/XTTS/MMS vary) to raw 16-bit mono PCM at a
 * fixed target sample rate, via a one-shot ffmpeg spawn. Reuses ffmpeg's
 * resampler rather than a hand-written one; chunks are small (a few seconds
 * of speech) so the per-call spawn cost is negligible against the multi-
 * second STT/translate/TTS round trip that already produced this audio.
 *
 * @param {Buffer} wavBuffer
 * @param {number} targetSampleRate must match liveAudioMixer's sampleRate
 * @returns {Promise<Buffer>} raw s16le mono PCM at targetSampleRate
 */
export function resampleWavToPcm(wavBuffer, targetSampleRate) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(targetSampleRate), '-ac', '1',
      'pipe:1',
    ]);
    const out = [];
    let stderr = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`resample ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      else resolve(Buffer.concat(out));
    });
    proc.stdin.end(wavBuffer);
  });
}

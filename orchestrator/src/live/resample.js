import { spawn } from 'node:child_process';

function ffmpegBinary() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * Converts a WAV buffer (gpu-service's TTS output, whatever the engine's
 * native sample rate is — Piper/XTTS/MMS vary) to raw 16-bit mono PCM at a
 * fixed target sample rate.
 *
 * Fast path: the TTS engines all emit plain 16-bit PCM WAV at a rate at or
 * below the mix rate, so it is parsed and linearly interpolated in-process.
 * That matters at scale — with ~100 languages the pipeline converts ~25 clips
 * per second, and a one-shot ffmpeg spawn per clip would burn a CPU core on
 * process startup alone. Anything unexpected (float WAV, a higher sample rate
 * than the target, malformed header) falls back to ffmpeg's resampler.
 *
 * @param {Buffer} wavBuffer
 * @param {number} targetSampleRate must match liveAudioMixer's sampleRate
 * @returns {Promise<Buffer>} raw s16le mono PCM at targetSampleRate
 */
export async function resampleWavToPcm(wavBuffer, targetSampleRate) {
  const fast = tryResampleInProcess(wavBuffer, targetSampleRate);
  if (fast) return fast;
  return resampleWithFfmpeg(wavBuffer, targetSampleRate);
}

/** Returns a Buffer, or null when the WAV is not a plain PCM16 file this fast path handles. */
export function tryResampleInProcess(wav, targetRate) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4);
    let size = wav.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      // Streaming writers may leave the size as 0 / 0xFFFFFFFF: use what is there.
      if (size === 0 || body + size > wav.length) size = wav.length - body;
      dataLen = size;
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) return null;
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2) return null;
  if (fmt.rate > targetRate || fmt.rate < 8000) return null;

  const frameBytes = 2 * fmt.channels;
  const frames = Math.floor(dataLen / frameBytes);
  if (frames === 0) return Buffer.alloc(0);

  // Mono mixdown into a Float64 scratch (cheap, avoids clipping on the average).
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = dataStart + i * frameBytes;
    mono[i] = fmt.channels === 1 ? wav.readInt16LE(o) : (wav.readInt16LE(o) + wav.readInt16LE(o + 2)) / 2;
  }

  if (fmt.rate === targetRate) {
    const out = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) out.writeInt16LE(Math.round(mono[i]), i * 2);
    return out;
  }
  const ratio = fmt.rate / targetRate; // < 1 (upsampling)
  const outFrames = Math.floor(frames / ratio);
  const out = Buffer.allocUnsafe(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, frames - 1);
    const frac = src - i0;
    const v = mono[i0] * (1 - frac) + mono[i1] * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

function resampleWithFfmpeg(wavBuffer, targetSampleRate) {
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

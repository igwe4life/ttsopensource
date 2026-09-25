// Adapted from ttsengine/src/stages/extractAudio.js — only the doc comment
// changed (Azure Speech -> Whisper/faster-whisper); the ffmpeg logic that
// produces a 16kHz mono WAV is identical either way.
import { runFfmpeg } from '../utils/ffmpeg.js';

/**
 * "Extract Original Audio" stage.
 *
 * Produces two artifacts from the downloaded source:
 *   - whisper.wav  : mono 16 kHz PCM — what the GPU service's Whisper/
 *                    faster-whisper engine expects (see gpu-service/app/
 *                    engines/stt/faster_whisper_engine.py).
 *   - original.wav : stereo 48 kHz PCM, kept full-quality for the final mix
 *                    / fallback-duck path.
 *
 * @param {string} source downloaded media file
 * @param {{ whisper: string, original: string }} out
 * @returns {Promise<{ whisper: string, original: string }>}
 */
export async function extractAudio(source, out) {
  console.log(`[extractAudio] ${source} → whisper + original WAVs`);

  // Whisper/faster-whisper-friendly: 16 kHz mono PCM (16-bit little-endian).
  await runFfmpeg(
    (cmd) =>
      cmd
        .input(source)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .audioCodec('pcm_s16le')
        .output(out.whisper),
    'extractAudio-whisper'
  );

  // Full-quality track for mixing (preserves stereo + sample rate).
  await runFfmpeg(
    (cmd) =>
      cmd
        .input(source)
        .noVideo()
        .audioCodec('pcm_s16le')
        .output(out.original),
    'extractAudio-original'
  );

  return out;
}

// Adapted from ttsengine/src/stages/alignAudio.js. The old engine aligned N
// per-phrase TTS clips to N phrase windows within a segment (word/phrase-level
// timing). The GPU service's /process (see gpu-service/app/pipeline/
// process_pipeline.py) synthesizes ONE clip per language per segment instead —
// a deliberate v1 simplification (see docs/ARCHITECTURE.md) that keeps the
// GPU-service API simple and batchable. This keeps the same atempo
// stretch-planning logic, just fitting one clip to the WHOLE segment duration
// instead of N clips to N phrase windows. Phrase-level alignment can be
// reintroduced later by having /process return per-segment timing without
// changing this file's public shape.
import { runFfmpeg, durationOf } from '../utils/ffmpeg.js';
import { ensureDir } from '../utils/fs.js';
import path from 'node:path';

// ffmpeg's atempo accepts 0.5–2.0 (–50% to +100%). Outside that we chain passes.
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2.0;

/**
 * Fit one whole-segment dubbed clip into the segment's duration.
 *
 * @param {string} clipFile  raw synthesized audio (wav) for this segment/language
 * @param {number} targetDuration  the segment's duration in seconds
 * @param {string} outDir   work dir for the aligned output
 * @returns {Promise<string>} path to the aligned wav
 */
export async function alignClipToSegment(clipFile, targetDuration, outDir) {
  await ensureDir(outDir);
  const target = Math.max(0.1, targetDuration);
  const natural = await durationOf(clipFile).catch(() => target);
  const outFile = path.join(outDir, 'aligned.wav');

  const { tempoChain, trim } = planStretch(natural, target);
  await renderClip(clipFile, outFile, tempoChain, trim ? target : null);
  return outFile;
}

/**
 * Decide how to map `natural` seconds into `target` seconds.
 * - tempo ratio clamped to [0.5, 1.5] (±50%) to keep speech intelligible.
 * - if clamped tempo still leaves the clip longer than the window, we trim.
 */
function planStretch(natural, target) {
  if (!Number.isFinite(natural) || natural <= 0) {
    return { tempoChain: [1.0], trim: false };
  }
  const desiredRatio = target / natural;
  const clamped = Math.min(1.5, Math.max(0.5, desiredRatio));
  const stretchedDuration = natural * clamped;
  const trim = stretchedDuration > target + 0.05;
  return { tempoChain: factorToAtempoChain(clamped), trim };
}

/** Split a ratio into one or more atempo factors within ffmpeg's allowed range. */
function factorToAtempoChain(ratio) {
  if (ratio >= ATEMPO_MIN && ratio <= ATEMPO_MAX) return [ratio];
  const chain = [];
  let remaining = ratio;
  while (remaining > ATEMPO_MAX) {
    chain.push(ATEMPO_MAX);
    remaining /= ATEMPO_MAX;
  }
  while (remaining < ATEMPO_MIN) {
    chain.push(ATEMPO_MIN);
    remaining /= ATEMPO_MIN;
  }
  if (Math.abs(remaining - 1) > 1e-3) chain.push(Math.max(ATEMPO_MIN, Math.min(ATEMPO_MAX, remaining)));
  return chain.length ? chain : [1.0];
}

function renderClip(inFile, outFile, tempoChain, trimTo) {
  const filters = [];
  const tempos = tempoChain.map((t) => `atempo=${t.toFixed(4)}`).join(',');
  filters.push(tempos);
  if (trimTo) {
    filters.push(`apad=whole_dur=${trimTo.toFixed(3)}`, `atrim=0:${trimTo.toFixed(3)}`);
  }
  filters.push('aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo');

  return runFfmpeg(
    (cmd) =>
      cmd
        .input(inFile)
        .audioFilters(filters.join(','))
        .noVideo()
        .audioCodec('pcm_s16le')
        .output(outFile),
    `align-${path.basename(outFile)}`
  );
}

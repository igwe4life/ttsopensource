import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { durationOf } from '../utils/ffmpeg.js';

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Adapted from ttsengine/src/live/remux.js. The ffmpeg remux itself
// (video copy + dubbed AAC audio -> one .ts) is unchanged; only the
// destination changed, from feeding one long-running RTMP pusher's stdin to
// becoming a numbered segment file in a per-language rolling HLS window (see
// hlsPlaylistWriter.js).
/**
 * Remux one segment: copy the original video untouched and replace its audio
 * with the dubbed track, producing a single .ts this language's HLS playlist
 * can reference as a segment (see hlsPlaylistWriter.js).
 *
 * Audio is normalized to AAC 48kHz stereo so every segment shares identical
 * codec params — that matters for HLS players seeking/switching across
 * segment boundaries without a re-encode.
 *
 * Timestamp continuity: each source segment has local timestamps starting near
 * its own beginning (~1.4s in practice). Without correction that causes a
 * jump at every segment boundary a player may glitch on. `tsOffset` shifts this
 * segment's output timestamps so they continue seamlessly from the previous
 * segment. The caller (segmentQueue) tracks the running offset across segments
 * and passes it here.
 *
 * @param {object} args
 * @param {string} args.inputTs     source .ts segment (has video + original audio)
 * @param {string} [args.audioPath] dubbed audio file (wav/mp3) to lay under the
 *   video. Required unless `fallback` is true.
 * @param {string} args.outputTs    resulting .ts path
 * @param {boolean} [args.fallback] if true, emit the segment with its OWN audio
 *   ducked to config.duckLevel (used when the dub misses its deadline).
 * @param {number} [args.tsOffset]  seconds to offset this segment's output
 *   timestamps by, for continuous timeline across concatenated segments.
 * @returns {Promise<{ outputTs:string, duration:number }>}
 */
export async function remuxSegment({ inputTs, audioPath, outputTs, fallback, tsOffset = 0 }) {
  const tsOffsetArgs = tsOffset > 0
    ? ['-output_ts_offset', String(tsOffset), '-avoid_negative_ts', 'make_zero']
    : [];

  if (fallback) {
    // Deadline-miss fallback: keep this segment's original audio, ducked.
    await execFileAsync(FFMPEG, [
      '-y',
      '-i', inputTs,
      '-filter:a', `volume=${config.duckLevel.toFixed(3)}`,
      '-map', '0:v',
      '-map', '0:a',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      ...tsOffsetArgs,
      '-f', 'mpegts',
      outputTs,
    ]);
  } else {
    // Normal path: original video + dubbed audio.
    await execFileAsync(FFMPEG, [
      '-y',
      '-i', inputTs, // 0: video (+ original audio, ignored)
      '-i', audioPath, // 1: dubbed audio
      '-map', '0:v',
      '-map', '1:a',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-shortest', // audio shouldn't exceed video; trim if it does
      ...tsOffsetArgs,
      '-f', 'mpegts',
      outputTs,
    ]);
  }
  const duration = await durationOf(outputTs).catch(() => 0);
  return { outputTs, duration };
}

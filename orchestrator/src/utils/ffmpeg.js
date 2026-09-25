// Reused verbatim from ttsengine/src/utils/ffmpeg.js — generic ffmpeg
// wrapper, no Azure/proprietary dependency, so nothing needed to change.
import ffmpegLib from 'fluent-ffmpeg';
import { pathToFileURL } from 'node:url';

// Allow overriding the ffmpeg binary path via env; otherwise expect it on PATH.
if (process.env.FFMPEG_PATH) {
  ffmpegLib.setFfmpegPath(process.env.FFMPEG_PATH);
}
if (process.env.FFPROBE_PATH) {
  ffmpegLib.setFfprobePath(process.env.FFPROBE_PATH);
}

/**
 * Probe a media file for stream/container metadata.
 * @param {string} file
 * @returns {Promise<object>} ffprobe output (format + streams)
 */
export function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpegLib.ffprobe(file, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * Run a fluent-ffmpeg command, resolving on completion.
 * The builder receives the `ffmpeg()` command to configure.
 *
 * @param {(cmd: import('fluent-ffmpeg').FfmpegCommand) => void} builder
 * @param {string} [label] optional stage label for logging
 * @returns {Promise<void>}
 */
export function runFfmpeg(builder, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const cmd = ffmpegLib();
    cmd.on('start', (cli) => console.debug(`[${label}] ${cli}`));
    cmd.on('error', (err, stdout, stderr) => {
      console.error(`[${label}] failed: ${err.message}`);
      if (stderr) console.error(`[${label}] stderr: ${stderr.slice(-1500)}`);
      reject(new Error(`ffmpeg ${label} failed: ${err.message}`));
    });
    cmd.on('end', () => resolve());
    builder(cmd);
    cmd.run();
  });
}

/**
 * Run an arbitrary ffmpeg command via argv (for complex filtergraphs that are
 * awkward to express through fluent-ffmpeg's builder API).
 *
 * @param {string[]} args
 * @param {string} [label]
 * @returns {Promise<void>}
 */
export function runFfmpegArgs(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const cmd = ffmpegLib();
    // fluent-ffmpeg builds argv from inputs/options; for full control we merge
    // onto a fresh command using its internal API surface.
    cmd.on('start', (cli) => console.debug(`[${label}] ${cli}`));
    cmd.on('error', (err, _stdout, stderr) => {
      console.error(`[${label}] failed: ${err.message}`);
      if (stderr) console.error(`[${label}] stderr: ${stderr.slice(-1500)}`);
      reject(new Error(`ffmpeg ${label} failed: ${err.message}`));
    });
    cmd.on('end', () => resolve());

    // Reconstruct from a flat argv list: expects [-i, input, ..., output].
    // We treat the last element as output, everything else as inputs/options.
    const output = args[args.length - 1];
    const rest = args.slice(0, -1);
    const inputs = [];
    const options = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-i' && i + 1 < rest.length) {
        inputs.push(rest[i + 1]);
        i++;
      } else {
        options.push(rest[i]);
      }
    }
    inputs.forEach((f) => cmd.addInput(pathToFileURL(f).href.startsWith('file:') ? f : f));
    options.forEach((o) => cmd.addInputOption(o));
    cmd.output(output);
    cmd.run();
  });
}

/**
 * Get the duration (seconds) of a media file via ffprobe.
 * @param {string} file
 * @returns {Promise<number>}
 */
export async function durationOf(file) {
  const data = await probe(file);
  const fromFormat = Number(data.format?.duration);
  if (Number.isFinite(fromFormat)) return fromFormat;
  // Fall back to longest stream duration.
  const streamDur = Math.max(
    0,
    ...data.streams.map((s) => Number(s.duration) || 0)
  );
  return streamDur;
}

// Adapted from ttsengine/src/live/segmentPipeline.js. The STT->translate->TTS
// chain moved to the GPU service (one /process call per segment, fanned out
// server-side to every active language — see gpu-service/app/pipeline/
// process_pipeline.py); what's left here is identical in spirit to the old
// file: extract audio once, then for EACH active language either mix the
// dubbed clip over a ducked original bed, or fall back to ducked original
// audio alone if that language's dub isn't ready/failed/had no speech.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import { ensureDir, removeDir } from '../utils/fs.js';
import { extractAudio } from './extractAudio.js';
import { alignClipToSegment } from './alignAudio.js';
import { remuxSegment } from './remux.js';
import { processSegment as gpuProcessSegment, decodeAudio } from '../gpuClient.js';

/**
 * Process ONE segment for the CURRENTLY ACTIVE set of languages.
 *
 * @param {{seq:number, duration:number, path:string}} seg
 * @param {string[]} activeLangs  languages with >=1 subscriber right now
 * @param {string} workDir  per-segment scratch dir
 * @param {number} deadlineMs  absolute Date.now() deadline
 * @returns {Promise<Record<string, { audioPath:string, fallback:boolean }>>}
 *   per-language dubbed (or ducked-fallback) wav ready for remux+HLS append
 */
export async function processSegmentForLanguages(seg, activeLangs, workDir, deadlineMs) {
  await ensureDir(workDir);
  const { path: inputTs, duration } = seg;

  if (activeLangs.length === 0) {
    return {}; // nobody is watching any language right now — do nothing
  }

  const audio = await extractAudio(inputTs, {
    whisper: path.join(workDir, 'whisper.wav'),
    original: path.join(workDir, 'original.wav'),
  });

  const timeLeftMs = Math.max(0, deadlineMs - Date.now());
  let gpuResult = null;
  try {
    const whisperBuf = await fs.readFile(audio.whisper);
    gpuResult = await Promise.race([
      gpuProcessSegment(whisperBuf, activeLangs, 'en'),
      timeout(timeLeftMs, 'gpu /process deadline'),
    ]);
  } catch (err) {
    console.warn(`[segmentPipeline] seg ${seg.seq}: /process failed or missed deadline: ${err.message}`);
  }

  const out = {};
  await Promise.all(
    activeLangs.map(async (lang) => {
      const langResult = gpuResult?.languages?.[lang];
      const langWork = path.join(workDir, lang);
      await ensureDir(langWork);

      if (langResult?.ok && langResult.audio_base64) {
        try {
          const rawClip = path.join(langWork, 'raw_tts.wav');
          await fs.writeFile(rawClip, decodeAudio(langResult));
          const aligned = await alignClipToSegment(rawClip, duration, langWork);
          const mixed = await mixSegment(audio.original, aligned, duration, path.join(langWork, 'mixed.wav'));
          out[lang] = { audioPath: mixed, fallback: false, text: langResult.text };
          return;
        } catch (err) {
          console.warn(`[segmentPipeline] seg ${seg.seq} [${lang}] mix failed, falling back: ${err.message}`);
        }
      } else if (langResult && !langResult.ok) {
        console.log(`[segmentPipeline] seg ${seg.seq} [${lang}] fallback: ${langResult.error}`);
      }

      const ducked = await duckOriginal(audio.original, path.join(langWork, 'ducked.wav'));
      out[lang] = { audioPath: ducked, fallback: true };
    })
  );

  return out;
}

/** Ducked-original fallback bed: fixed config.duckLevel volume, no compression. */
async function duckOriginal(originalWav, outWav) {
  const { runFfmpeg } = await import('../utils/ffmpeg.js');
  await runFfmpeg(
    (cmd) =>
      cmd
        .input(originalWav)
        .audioFilters(`volume=${config.duckLevel.toFixed(2)}`)
        .audioCodec('pcm_s16le')
        .output(outWav),
    'duck-original'
  );
  return outWav;
}

/** Mix one whole-segment dub clip over a fixed-volume original bed. */
async function mixSegment(originalWav, alignedClipPath, segmentDuration, outWav) {
  const { runFfmpeg } = await import('../utils/ffmpeg.js');
  const duck = config.duckLevel;
  const filterGraph = [
    `[0:a]volume=${duck.toFixed(2)}[ducked]`,
    `[1:a]volume=1.0[dub]`,
    `[ducked][dub]amix=inputs=2:duration=first:normalize=0[aout]`,
  ].join(';');

  await runFfmpeg((cmd) => {
    cmd.addInput(originalWav);
    cmd.addInput(alignedClipPath);
    cmd.complexFilter(filterGraph, ['aout']);
    cmd.outputOptions(['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', String(segmentDuration)]);
    cmd.output(outWav);
  }, 'mix-segment');
  return outWav;
}

/** Remux + return the .ts path for a language's processed audio. */
export async function remuxForLanguage(seg, langAudio, outputTs, tsOffset) {
  return remuxSegment({
    inputTs: seg.path,
    audioPath: langAudio.audioPath,
    outputTs,
    fallback: langAudio.fallback,
    tsOffset,
  });
}

export async function cleanupSegmentWork(seg, segWork) {
  await fs.rm(seg.path, { force: true }).catch(() => {});
  await removeDir(segWork).catch(() => {});
}

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(label)), Math.max(0, ms)));
}

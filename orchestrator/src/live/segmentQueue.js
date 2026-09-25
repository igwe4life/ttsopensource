// Adapted from ttsengine/src/live/segmentQueue.js. Same pipelined,
// bounded-concurrency, strictly-in-order-emission shape as the original, but:
//   - each active language now gets its dub emitted to HLS (files, no
//     cross-segment timestamp bookkeeping needed — see hlsPlaylistWriter.js)
//     AND, for any language with a configured RTMP target (rtmpManager),
//     ALSO pushed to a persistent RTMP stream the same way the old engine
//     did (one long-running ffmpeg fed via stdin, which DOES need continuous
//     timestamps across segments — see rtmpOutputManager.js's doc comment).
//   - a segment's dub is computed for MULTIPLE languages at once (whichever
//     are active), not one language per process.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import { createHlsPlaylistWriter } from './hlsPlaylistWriter.js';
import {
  processSegmentForLanguages,
  remuxForLanguage,
  cleanupSegmentWork,
} from './segmentPipeline.js';

/**
 * @param {object} opts
 * @param {string} opts.workRoot        work dir root (e.g. work/ingest)
 * @param {object} opts.sharedPipeline  from sharedPipelineManager.js
 * @param {object} [opts.rtmpManager]   from rtmpOutputManager.js — omit for
 *   HLS-only operation (default)
 */
export function createSegmentQueue({ workRoot, sharedPipeline, rtmpManager = null }) {
  const concurrency = config.pipelineConcurrency;
  const deadlineMs = config.segmentDeadlineMs;

  let nextEmitSeq = null;
  const pending = new Map(); // seq -> per-language results (or null on total failure)
  let active = 0;
  const inputQueue = [];
  let stopped = false;

  const playlistWriters = new Map(); // lang -> writer (created lazily, on first segment)

  async function getWriter(lang) {
    let w = playlistWriters.get(lang);
    if (!w) {
      w = createHlsPlaylistWriter({
        lang,
        rootDir: path.join(workRoot, config.hlsOutput.dir),
        windowSegments: config.hlsOutput.windowSegments,
      });
      await w.init();
      playlistWriters.set(lang, w);
    }
    return w;
  }

  function enqueue(seg) {
    const slot = { seg, done: null };
    slot.done = new Promise((resolve) => {
      slot.resolve = resolve;
    });
    inputQueue.push(slot);
    pump();
    return slot.done;
  }

  function pump() {
    while (active < concurrency && inputQueue.length > 0 && !stopped) {
      const slot = inputQueue.shift();
      active++;
      processOne(slot).catch((err) => {
        console.error(`[queue] seg ${slot.seg.seq} fatal: ${err.message}`);
      });
    }
  }

  async function processOne(slot) {
    const { seg } = slot;
    const segWork = path.join(workRoot, `seg_${seg.seq}`);
    const deadline = Date.now() + deadlineMs;
    const startedAt = Date.now();
    const activeLangs = sharedPipeline.activeLanguages();

    let perLang = {};
    try {
      perLang = await processSegmentForLanguages(seg, activeLangs, segWork, deadline);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const dubbed = Object.values(perLang).filter((r) => !r.fallback).length;
      console.log(
        `[queue] seg ${seg.seq} ready in ${elapsed}s — ${dubbed}/${activeLangs.length} languages dubbed`
      );
    } catch (err) {
      console.error(`[queue] seg ${seg.seq} processing error: ${err.message}`);
    }

    registerForEmission(seg.seq, { seg, perLang });
    active--;
    pump();
  }

  /** Buffer a finished segment and flush any that are now in order. */
  function registerForEmission(seq, payload) {
    if (nextEmitSeq === null) nextEmitSeq = seq;
    pending.set(seq, payload);
    flush().catch((err) => console.error(`[queue] flush error: ${err.message}`));
  }

  async function flush() {
    while (pending.has(nextEmitSeq)) {
      const { seg, perLang } = pending.get(nextEmitSeq);
      pending.delete(nextEmitSeq);

      const segWork = path.join(workRoot, `seg_${seg.seq}`);
      for (const [lang, langAudio] of Object.entries(perLang)) {
        // HLS output — every active language gets this, regardless of RTMP config.
        try {
          const writer = await getWriter(lang);
          const outTsHls = path.join(segWork, `out_${seg.seq}_${lang}_hls.ts`);
          const { duration } = await remuxForLanguage(seg, langAudio, outTsHls, 0);
          await writer.appendSegment(seg.seq, outTsHls, duration || seg.duration);
        } catch (err) {
          console.error(`[queue] seg ${seg.seq} [${lang}] HLS emit failed: ${err.message}`);
        }

        // RTMP output — only for languages with a persistent target configured
        // (see rtmp-targets.json.example / index.js --rtmp-targets).
        if (rtmpManager?.has(lang)) {
          try {
            const offset = rtmpManager.nextOffset(lang, seg.duration);
            const outTsRtmp = path.join(segWork, `out_${seg.seq}_${lang}_rtmp.ts`);
            await remuxForLanguage(seg, langAudio, outTsRtmp, offset);
            const buf = await fs.readFile(outTsRtmp);
            rtmpManager.get(lang).pusher.write(buf);
          } catch (err) {
            console.error(`[queue] seg ${seg.seq} [${lang}] RTMP emit failed: ${err.message}`);
          }
        }
      }
      cleanupSegmentWork(seg, segWork); // fire-and-forget, disk stays flat

      nextEmitSeq++;
    }
  }

  async function drain() {
    stopped = true;
    while (active > 0) await sleep(100);
    await flush();
    for (const writer of playlistWriters.values()) await writer.end();
  }

  return {
    enqueue,
    drain,
    get stopped() {
      return stopped;
    },
    playlistFor(lang) {
      return playlistWriters.get(lang)?.playlistPath || null;
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

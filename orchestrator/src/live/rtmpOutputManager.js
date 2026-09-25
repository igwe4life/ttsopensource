import { createRtmpPusher } from './rtmpPush.js';

/**
 * Manages one persistent RTMP pusher PER LANGUAGE that has a configured RTMP
 * target (see rtmp-targets.json.example) — the same "one long-running ffmpeg,
 * one stream key" model the old ttsengine used, just fanned out across
 * languages instead of one process per language.
 *
 * Unlike hlsPlaylistWriter.js (standalone segment files, no cross-segment
 * timestamp bookkeeping needed), a raw MPEG-TS byte stream fed into one
 * ffmpeg's stdin via `-c copy` DOES need continuous timestamps across
 * segment boundaries, or players see a jump/glitch at every segment — see
 * the old engine's remux.js doc comment. So this manager tracks a running
 * `tsOffset` per language and hands it to remux.js on each segment.
 */
export function createRtmpOutputManager() {
  const targets = new Map(); // lang -> { rtmpUrl, pusher, tsOffset }

  /** Start (or return the existing) persistent pusher for `lang`. */
  async function addTarget(lang, rtmpUrl) {
    const existing = targets.get(lang);
    if (existing) return existing;
    console.log(`[rtmp] starting persistent push for '${lang}' -> ${rtmpUrl}`);
    const pusher = await createRtmpPusher(rtmpUrl);
    const target = { rtmpUrl, pusher, tsOffset: 0 };
    targets.set(lang, target);
    return target;
  }

  function has(lang) {
    return targets.has(lang);
  }

  function get(lang) {
    return targets.get(lang);
  }

  function languages() {
    return [...targets.keys()];
  }

  /** Returns this segment's offset for `lang`, then advances the running total. */
  function nextOffset(lang, segmentDuration) {
    const t = targets.get(lang);
    if (!t) return 0;
    const offset = t.tsOffset;
    t.tsOffset += segmentDuration;
    return offset;
  }

  async function shutdown() {
    await Promise.all(
      [...targets.values()].map(async (t) => {
        t.pusher.end();
        await Promise.race([t.pusher.waitForExit(), new Promise((r) => setTimeout(r, 5000))]);
      })
    );
  }

  return { addTarget, has, get, languages, nextOffset, shutdown };
}

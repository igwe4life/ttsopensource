import { config } from '../config.js';

/**
 * Section 5, second example: "100 viewers select Spanish -> ONE Spanish
 * processing pipeline -> ONE Spanish HLS stream -> 100 viewers."
 *
 * This is that dedup layer. Viewers don't get their own pipeline — they
 * subscribe to a language code. The set of languages with >=1 subscriber is
 * the `activeLanguages()` list that gets sent to the GPU service's /process
 * call each segment (see segmentPipeline.js). A language with zero
 * subscribers is simply left out of that list — its dubbing pipeline stops
 * doing work without any explicit "stop" step, and resumes the moment a new
 * viewer subscribes. Because HLS output is just files on disk (hlsOutput.js),
 * "one shared stream" for N viewers of the same language falls out for free
 * from ordinary static file serving — no per-viewer connection to manage.
 *
 * A short idle grace period (`pipelineIdleGraceMs`) avoids flapping a
 * language on/off when a viewer briefly reloads the page.
 */
export function createSharedPipelineManager() {
  const refCounts = new Map(); // lang -> count
  const pendingStop = new Map(); // lang -> Timeout

  function subscribe(lang) {
    const existingTimer = pendingStop.get(lang);
    if (existingTimer) {
      clearTimeout(existingTimer);
      pendingStop.delete(lang);
    }
    const wasActive = (refCounts.get(lang) || 0) > 0;
    refCounts.set(lang, (refCounts.get(lang) || 0) + 1);
    if (!wasActive) {
      console.log(`[sharedPipeline] '${lang}' now active (first viewer)`);
    }
    return refCounts.get(lang);
  }

  function unsubscribe(lang) {
    const count = Math.max(0, (refCounts.get(lang) || 0) - 1);
    refCounts.set(lang, count);
    if (count === 0) {
      const timer = setTimeout(() => {
        if ((refCounts.get(lang) || 0) === 0) {
          console.log(`[sharedPipeline] '${lang}' idle after grace period -> pausing`);
          refCounts.delete(lang);
        }
        pendingStop.delete(lang);
      }, config.pipelineIdleGraceMs);
      timer.unref();
      pendingStop.set(lang, timer);
    }
    return count;
  }

  /** Languages that currently have at least one subscriber (or are within
   *  their idle grace window) — the list sent to the GPU service each segment. */
  function activeLanguages() {
    return [...refCounts.entries()].filter(([, n]) => n > 0).map(([lang]) => lang);
  }

  function subscriberCount(lang) {
    return refCounts.get(lang) || 0;
  }

  return { subscribe, unsubscribe, activeLanguages, subscriberCount };
}

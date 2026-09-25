const BYTES_PER_SAMPLE = 2; // 16-bit PCM, mono

/**
 * Feeds a continuous, real-time-paced PCM byte stream for ONE language's
 * translated-audio track, to be mixed live (via ffmpeg's amix, see
 * rtmpLanguagePusher.js) with the source's own audio.
 *
 * Why this exists: ffmpeg mixes multiple real-time inputs in lockstep — if
 * one input's pipe has no data available, the WHOLE mux stalls, even if the
 * other input (the live source) has data ready. Translated audio arrives in
 * irregular bursts (STT/translate/TTS takes a few seconds, not zero), so the
 * pipe feeding ffmpeg must never go quiet: this queues real translated PCM
 * as it arrives and, on a steady tick, emits either real audio (if queued)
 * or silence, at the EXACT byte rate the sample rate demands — silence never
 * "catches up" or "falls behind" real time, it just fills gaps.
 *
 * No time-stretching/alignment to a fixed window (unlike the old
 * alignAudio.js, from the segment-based architecture this replaced):
 * translated speech simply overlays for however long it naturally takes,
 * on top of the continuous ducked original underneath — simpler, and there
 * is no fixed-duration slot it needs to fit into anymore.
 */
export function createLiveAudioMixer({ sampleRate, maxQueuedSeconds = 8 }) {
  const bytesPerSecond = sampleRate * BYTES_PER_SAMPLE;
  const maxQueuedBytes = Math.round(maxQueuedSeconds * bytesPerSecond);
  let queue = Buffer.alloc(0);
  let lastTick = null;
  let onData = null; // set via pump()

  /**
   * Append newly-arrived translated PCM (already resampled to `sampleRate`).
   * Capped at `maxQueuedSeconds`: if a processing slowdown ever lets this
   * queue grow past that, drop the OLDEST excess rather than let translated
   * audio drift further and further behind real time without bound (found
   * via live testing: an uncapped queue here let delay grow to multiple
   * minutes over a session instead of recovering).
   */
  function enqueue(pcmBuffer) {
    queue = queue.length ? Buffer.concat([queue, pcmBuffer]) : pcmBuffer;
    if (queue.length > maxQueuedBytes) {
      queue = queue.subarray(queue.length - maxQueuedBytes);
    }
  }

  /**
   * Start the real-time pump. Call once; `onEmit(buffer)` is invoked
   * repeatedly with exactly the right number of bytes for elapsed wall-clock
   * time (queued real audio first, silence-padded).
   */
  function pump(onEmit, tickMs = 100) {
    onData = onEmit;
    lastTick = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsedSeconds = (now - lastTick) / 1000;
      lastTick = now;
      let neededBytes = Math.round(elapsedSeconds * bytesPerSecond);
      // Keep byte counts sample-aligned (even numbers for 16-bit PCM).
      neededBytes -= neededBytes % BYTES_PER_SAMPLE;
      if (neededBytes <= 0) return;

      const fromQueue = queue.subarray(0, Math.min(neededBytes, queue.length));
      queue = queue.subarray(fromQueue.length);
      const silenceNeeded = neededBytes - fromQueue.length;
      const out = silenceNeeded > 0
        ? Buffer.concat([fromQueue, Buffer.alloc(silenceNeeded)])
        : fromQueue;
      onData(out);
    }, tickMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { enqueue, pump, get queuedBytes() { return queue.length; } };
}

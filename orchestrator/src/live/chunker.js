const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono PCM

/**
 * Accumulates a continuous raw-PCM byte stream (as emitted by audioCapture.js)
 * into fixed-duration windows, each carrying a small trailing overlap from the
 * previous window so Whisper's own Silero VAD (already on via vad_filter=True
 * in the STT engine) can anchor on real silence instead of a hard cut
 * mid-word at an arbitrary chunk boundary. This is a deliberate v1
 * simplification — real VAD-based chunking (cutting at actual pauses) would
 * read better but adds a dependency and complexity not needed yet.
 *
 * Pure in-memory Buffer accumulation — no disk writes.
 */
export function createChunker({ chunkSeconds, overlapMs }) {
  const chunkBytes = Math.round(SAMPLE_RATE * BYTES_PER_SAMPLE * chunkSeconds);
  const overlapBytes = evenSampleAligned(Math.round(SAMPLE_RATE * BYTES_PER_SAMPLE * (overlapMs / 1000)));

  let buffer = Buffer.alloc(0);

  /**
   * Feed raw PCM bytes; returns an array (usually 0 or 1 items, occasionally
   * more if a lot of data arrived at once) of ready-to-send WAV Buffers.
   */
  function push(pcmChunk) {
    buffer = buffer.length ? Buffer.concat([buffer, pcmChunk]) : pcmChunk;
    const ready = [];
    while (buffer.length >= chunkBytes) {
      const windowPcm = buffer.subarray(0, chunkBytes);
      ready.push(pcmToWav(windowPcm, SAMPLE_RATE));
      // Keep the trailing `overlapBytes` for the next window instead of
      // discarding everything, so speech spanning the boundary isn't cut
      // twice with no shared context.
      buffer = buffer.subarray(chunkBytes - overlapBytes);
    }
    return ready;
  }

  return { push };
}

function evenSampleAligned(bytes) {
  return bytes - (bytes % BYTES_PER_SAMPLE);
}

/** Wrap raw 16-bit mono PCM in a minimal 44-byte WAV header. */
export function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

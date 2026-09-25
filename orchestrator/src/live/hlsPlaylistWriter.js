import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir } from '../utils/fs.js';

/**
 * Writes a rolling-window live HLS media playlist for ONE language, replacing
 * the old engine's rtmpPush.js (which fed one long-running ffmpeg's stdin).
 * Output here is just files: a `playlist.m3u8` plus numbered `.ts` segments in
 * `<hlsOutput.dir>/<lang>/`.
 *
 * This is deliberately dumb (no ffmpeg `-f hls` muxer) because segments
 * already arrive as complete, correctly-timestamped .ts files from remux.js —
 * all that's needed is a sliding-window manifest and old-segment cleanup, the
 * same "disk stays flat" property the old engine had for RTMP.
 *
 * Because this is just static files, N viewers of the same language all read
 * the SAME playlist.m3u8 + .ts files over plain HTTP — the "one shared stream
 * for 100 viewers" requirement in section 5 falls out for free; there is
 * nothing per-viewer to create.
 */
export function createHlsPlaylistWriter({ lang, rootDir, windowSegments = 6, initialTargetDuration = 8 }) {
  const dir = path.join(rootDir, lang);
  const playlistPath = path.join(dir, 'playlist.m3u8');
  const playlistTmpPath = path.join(dir, '.playlist.m3u8.tmp');

  let mediaSequence = 0;
  const window = []; // { seq, file, duration }
  let targetDuration = initialTargetDuration;
  let ended = false;

  async function init() {
    await ensureDir(dir);
  }

  /**
   * Append a finished segment (already remuxed .ts on disk at `srcPath`).
   * Moves/renames it into this language's HLS dir as seg_<seq>.ts, updates
   * the sliding window, evicts the oldest segment past `windowSegments`, and
   * rewrites playlist.m3u8 atomically (write tmp + rename) so a viewer never
   * reads a half-written manifest.
   */
  async function appendSegment(seq, srcPath, duration) {
    const fileName = `seg_${seq}.ts`;
    const destPath = path.join(dir, fileName);
    await fs.rename(srcPath, destPath).catch(async (err) => {
      // Cross-device rename (different filesystem/drive) falls back to copy+unlink.
      if (err.code === 'EXDEV') {
        await fs.copyFile(srcPath, destPath);
        await fs.unlink(srcPath);
      } else {
        throw err;
      }
    });

    window.push({ seq, file: fileName, duration });
    targetDuration = Math.max(targetDuration, Math.ceil(duration));

    while (window.length > windowSegments) {
      const evicted = window.shift();
      mediaSequence = evicted.seq + 1;
      await fs.rm(path.join(dir, evicted.file), { force: true }).catch(() => {});
    }

    await writePlaylist();
  }

  async function writePlaylist() {
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    ];
    for (const seg of window) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`, seg.file);
    }
    if (ended) lines.push('#EXT-X-ENDLIST');
    const body = lines.join('\n') + '\n';

    await fs.writeFile(playlistTmpPath, body, 'utf8');
    await fs.rename(playlistTmpPath, playlistPath); // atomic on the same filesystem
  }

  async function end() {
    ended = true;
    await writePlaylist();
  }

  return { init, appendSegment, end, get playlistPath() { return playlistPath; }, get dir() { return dir; } };
}

// Reused verbatim from ttsengine/src/live/playlistPoller.js — polling a live
// HLS media playlist is identical regardless of what happens to the audio
// downstream, so nothing here needed to change for the open-source pipeline.
import { Parser } from 'm3u8-parser';
import { config } from '../config.js';

/**
 * Live HLS playlist poller.
 *
 * Fetches the media playlist on a timer, parses it with m3u8-parser, and yields
 * each newly-appearing .ts segment as an async iterator. This is the live
 * equivalent of hls.js's segment loader, in Node: we discover segments by their
 * absolute media-sequence number (manifest.mediaSequence + index).
 *
 * Resolves relative segment URIs against the playlist base URL. Stops when the
 * source signals end (#EXT-X-ENDLIST).
 *
 * The poller downloads segment *bytes* to disk and yields the local path, so
 * downstream stages never touch the network directly.
 *
 * @param {string} mediaPlaylistUrl  full URL to the media (chunklist) .m3u8
 * @param {string} ingestDir          where to save .ts segments
 * @returns {AsyncGenerator<import('../types.js').LiveSegment>}
 */
export async function* pollLivePlaylist(mediaPlaylistUrl, ingestDir) {
  const baseUrl = mediaPlaylistUrl.slice(0, mediaPlaylistUrl.lastIndexOf('/') + 1);
  let highestSeq = -1;
  let targetDuration = 12; // learned from the playlist

  while (true) {
    let manifest;
    try {
      manifest = await fetchAndParse(mediaPlaylistUrl);
    } catch (err) {
      console.warn(`[poller] fetch failed: ${err.message}; retrying`);
      await sleep(Math.min((targetDuration * 1000) / config.pollIntervalDivisor, 10000));
      continue;
    }

    targetDuration = manifest.targetDuration || targetDuration;
    const pollMs = Math.max(1000, (targetDuration * 1000) / config.pollIntervalDivisor);

    if (manifest.endList) {
      console.log('[poller] source signaled #EXT-X-ENDLIST; draining remaining segments');
      for (const seg of newSegments(manifest, baseUrl, highestSeq, ingestDir)) {
        highestSeq = Math.max(highestSeq, seg.seq);
        yield seg;
      }
      console.log('[poller] source ended');
      return;
    }

    for (const seg of newSegments(manifest, baseUrl, highestSeq, ingestDir)) {
      highestSeq = Math.max(highestSeq, seg.seq);
      // Download before yielding so the path exists when the consumer reads it.
      await downloadSegment(seg);
      yield seg;
    }

    await sleep(pollMs);
  }
}

/** Fetch + parse one playlist snapshot. Throws on non-2xx / network error. */
async function fetchAndParse(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest;
}

/**
 * Build the list of segments newer than `sinceSeq`, as descriptor objects.
 * Descriptors carry the *absolute* media-sequence number and a resolved URL.
 * Does NOT download — the caller decides whether to download before yielding.
 */
function* newSegments(manifest, baseUrl, sinceSeq, ingestDir) {
  const start = manifest.mediaSequence || 0;
  for (let i = 0; i < manifest.segments.length; i++) {
    const seq = start + i;
    if (seq <= sinceSeq) continue;
    const seg = manifest.segments[i];
    const uri = seg.uri;
    const resolved = /^https?:\/\//i.test(uri) ? uri : baseUrl + uri;
    yield {
      seq,
      duration: seg.duration,
      url: resolved,
      path: `${ingestDir}/seg_${seq}.ts`,
    };
  }
}

/** Stream-download a segment .ts to disk. */
async function downloadSegment(seg) {
  const res = await fetch(seg.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`segment ${seg.seq} download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import('node:fs/promises');
  await writeFile(seg.path, buf);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the media (chunklist) URL from a possibly-master playlist URL.
 * If `url` is itself a media playlist (has #EXTINF), return it as-is.
 */
export async function resolveMediaPlaylist(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist`);
  const text = await res.text();
  if (text.includes('#EXT-X-STREAM-INF')) {
    // Master playlist: follow the first variant.
    const parser = new Parser();
    parser.push(text);
    parser.end();
    const firstVariant = parser.manifest.playlists?.[0];
    if (!firstVariant) throw new Error('Master playlist had no variants');
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    return /^https?:\/\//i.test(firstVariant.uri)
      ? firstVariant.uri
      : base + firstVariant.uri;
  }
  return url; // already a media playlist
}

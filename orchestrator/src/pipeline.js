// Adapted from ttsengine/src/pipeline.js. Structurally the same shutdown/
// polling shape; RTMP pusher + reporter replaced by the segment queue's HLS
// playlist writers and (optionally) the same admin-telemetry reporter
// pattern, now pointed at the GPU service's /health instead of Azure.
import { config } from './config.js';
import { ensureDir } from './utils/fs.js';
import { pollLivePlaylist, resolveMediaPlaylist } from './live/playlistPoller.js';
import { createSegmentQueue } from './live/segmentQueue.js';

/**
 * Runs ONE source HLS stream through the dubbing pipeline, producing
 * multiple OUTPUT HLS streams (one per active target language) under
 * `<workDir>/<hlsOutput.dir>/<lang>/playlist.m3u8`.
 *
 * Unlike the old engine (one process per target language, one RTMP key
 * each), this is ONE process for the whole source stream — languages are
 * added/removed dynamically as viewers subscribe/unsubscribe via
 * sharedPipelineManager, without restarting anything (section 5/6).
 *
 * @param {object} opts
 * @param {string} opts.input     source HLS URL (master or media playlist)
 * @param {object} opts.sharedPipeline  from sharedPipelineManager.js
 * @param {string} [opts.workDir] scratch dir (default ./work/ingest)
 * @param {object} [opts.rtmpManager]  from rtmpOutputManager.js — omit for
 *   HLS-only operation; when given, any language it manages ALSO gets a
 *   persistent RTMP push each segment (see segmentQueue.js).
 * Never throws past startup: a source that's briefly unreachable (DNS hiccup,
 * origin restart) retries in the background instead of taking the HTTP API
 * down with it — index.js starts the HTTP server unconditionally, and
 * `/health` reflects source-connection state via `queue`-less `status()`.
 *
 * @returns {{ queue: object, shutdown: (signal:string) => Promise<void>, status: () => object }}
 */
export function runDubbingPipeline(opts) {
  const { input, sharedPipeline, rtmpManager = null } = opts;
  if (!input) throw new Error('Pipeline needs an `input` HLS URL.');

  const workDir = opts.workDir || 'work/ingest';
  const ingestDir = `${workDir}/segments`;

  console.log('[pipeline] ttsopensource live dubbing');
  console.log(`[pipeline]   source: ${input}`);
  console.log(`[pipeline]   deadline: ${config.segmentDeadlineMs}ms, concurrency: ${config.pipelineConcurrency}`);
  if (rtmpManager) console.log(`[pipeline]   RTMP targets: ${rtmpManager.languages().join(', ') || '(none yet)'}`);

  const queue = createSegmentQueue({ workRoot: workDir, sharedPipeline, rtmpManager });

  let shuttingDown = false;
  let connected = false;
  let lastError = null;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[pipeline] ${signal} received, shutting down…`);
    await queue.drain();
    if (rtmpManager) await rtmpManager.shutdown();
  };

  async function resolveWithRetry() {
    let attempt = 0;
    while (!shuttingDown) {
      try {
        const mediaUrl = await resolveMediaPlaylist(input);
        if (mediaUrl !== input) console.log(`[pipeline]   media playlist: ${mediaUrl}`);
        return mediaUrl;
      } catch (err) {
        lastError = err.message;
        const backoff = Math.min(2000 * 2 ** attempt++, 30000);
        console.warn(`[pipeline] source unreachable (${err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    return null;
  }

  (async () => {
    await ensureDir(workDir);
    await ensureDir(ingestDir);

    const mediaUrl = await resolveWithRetry();
    if (!mediaUrl) return; // shut down while still retrying

    connected = true;
    let count = 0;
    try {
      for await (const seg of pollLivePlaylist(mediaUrl, ingestDir)) {
        count++;
        console.log(`[pipeline] segment ${seg.seq} ingested (${seg.duration}s)`);
        queue.enqueue(seg).catch((err) => {
          console.error(`[pipeline] seg ${seg.seq} enqueue error: ${err.message}`);
        });
      }
    } catch (err) {
      lastError = err.message;
      console.error(`[pipeline] poller error: ${err.message}`);
    }
    connected = false;
    console.log(`[pipeline] source ended after ${count} segments; draining…`);
    await queue.drain();
  })();

  return { queue, shutdown, status: () => ({ connected, source: input, lastError }) };
}

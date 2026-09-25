import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import * as gpuClient from './gpuClient.js';

/**
 * HTTP API + static HLS host.
 *
 * GET  /languages          registry-driven list with UI status (available/
 *                           limited/experimental/unsupported) — section 6
 * POST /select   {lang}    viewer subscribes to a language (ref-counted via
 *                           sharedPipelineManager — section 5)
 * POST /unselect {lang}    viewer unsubscribes
 * GET  /hls/:lang/*        static-serves that language's playlist.m3u8 + .ts
 *                           segments — the SAME files for every subscriber
 * GET  /health              this process + GPU service health
 * GET  /original.m3u8       passthrough of the original source playlist, so a
 *                           viewer can also just watch un-dubbed (section 1:
 *                           "the original video should remain available")
 */
export function createServer({ workDir, sharedPipeline, sourceInput, pipeline, rtmpManager = null }) {
  const app = express();
  app.use(express.json());

  const hlsRoot = path.join(workDir, config.hlsOutput.dir);
  app.use('/hls', express.static(hlsRoot, { maxAge: 0 })); // live playlists must never be cached

  app.get('/languages', (_req, res) => {
    const langs = config.allLanguages().map((l) => ({
      language_code: l.language_code,
      language_name: l.language_name,
      native_name: l.native_name,
      status: l.status, // available | limited | experimental | unsupported
      quality_level: l.quality_level,
      enabled: l.enabled,
      priority: l.priority,
      subscribers: sharedPipeline.subscriberCount(l.language_code),
      hls_url: l.enabled ? `/hls/${l.language_code}/playlist.m3u8` : null,
    }));
    res.json({ source: sourceInput, original_hls_note: 'proxy or link the original source URL directly for un-dubbed playback', languages: langs });
  });

  app.post('/select', (req, res) => {
    const lang = String(req.body?.lang || '').toLowerCase();
    const entry = config.languageEntry(lang);
    if (!entry || !entry.enabled) {
      return res.status(422).json({ error: `language '${lang}' is not enabled` });
    }
    const count = sharedPipeline.subscribe(lang);
    res.json({ lang, subscribers: count, hls_url: `/hls/${lang}/playlist.m3u8` });
  });

  app.post('/unselect', (req, res) => {
    const lang = String(req.body?.lang || '').toLowerCase();
    const count = sharedPipeline.unsubscribe(lang);
    res.json({ lang, subscribers: count });
  });

  app.get('/health', async (_req, res) => {
    let gpu = null;
    try {
      gpu = await gpuClient.health();
    } catch (err) {
      gpu = { status: 'unreachable', error: err.message };
    }
    res.json({
      status: 'ok',
      source: pipeline?.status ? pipeline.status() : null,
      active_languages: sharedPipeline.activeLanguages(),
      rtmp_targets: rtmpManager
        ? rtmpManager.languages().map((lang) => ({
            lang,
            rtmp_url: rtmpManager.get(lang).rtmpUrl,
            alive: rtmpManager.get(lang).pusher.alive,
          }))
        : [],
      gpu_service: gpu,
    });
  });

  return app;
}

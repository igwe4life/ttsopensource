import express from 'express';
import { config } from './config.js';
import * as gpuClient from './gpuClient.js';

/**
 * Monitoring-only HTTP API — no browser UI, no viewer routes. Every
 * configured language is always being generated and pushed to its own RTMP
 * destination (see pipeline.js); this just reports status.
 *
 * GET /health      this process + gpu-service health + per-language RTMP push state
 * GET /languages   the fixed set of languages this build broadcasts
 */
export function createServer({ sourceInput, pipeline }) {
  const app = express();

  // Local source relay (see live/sourceRelay.js): the per-language ffmpeg
  // pushers read their video from here when SOURCE_RELAY=true.
  if (pipeline?.relayDir) {
    app.use(
      '/relay',
      express.static(pipeline.relayDir, {
        etag: false,
        lastModified: false,
        setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
      })
    );
  }

  app.get('/languages', (_req, res) => {
    const languages = config.targetLanguages.map((code) => {
      const entry = config.languageEntry(code);
      return {
        language_code: code,
        language_name: entry?.language_name || code,
        native_name: entry?.native_name || code,
        rtmp_url: `${config.rtmp.baseUrl.replace(/\/+$/, '')}/${config.rtmp.keyFor(code)}`,
      };
    });
    res.json({ source: sourceInput, languages });
  });

  app.get('/health', async (_req, res) => {
    const gpus = await gpuClient.healthAll();
    res.json({
      status: 'ok',
      source: pipeline?.status ? pipeline.status() : null,
      gpu_service: gpus[0],
      gpu_services: gpus,
    });
  });

  return app;
}

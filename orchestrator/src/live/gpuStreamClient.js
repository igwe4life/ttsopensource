import WebSocket from 'ws';

/**
 * Persistent WebSocket client for gpu-service's /ws/stream (see
 * gpu-service/app/ws/stream_ws.py for the protocol this mirrors exactly).
 * Replaces the old gpuClient.js's per-segment HTTP POST /process — one
 * connection stays open for the life of the pipeline instead of paying
 * reconnect/TLS overhead on every chunk.
 *
 * The server reads one segment (a text control frame + one binary WAV frame)
 * fully to completion before reading the next, so this client naturally
 * back-pressures: `sendSegment` doesn't resolve (and the caller shouldn't
 * send the next segment) until every requested language has reported a
 * result (or errored), or `timeoutMs` elapses.
 *
 * @param {object} opts
 * @param {string} opts.url        ws:// or wss:// URL for /ws/stream
 * @param {string} [opts.apiKey]   sent as the X-Api-Key handshake header
 * @param {number} [opts.timeoutMs] per-segment ceiling before giving up
 * @param {(lang:string, meta:object, audio:Buffer|null) => void} opts.onLanguageResult
 *   called as each language's result streams back — meta has {ok, text,
 *   error, translation_engine, tts_engine, sample_rate}
 */
export function createGpuStreamClient({ url, apiKey, timeoutMs = 20000, onLanguageResult }) {
  let ws = null;
  let connected = false;
  let connectAttempt = 0;
  let closedByUs = false;

  // In-flight segment state — only one segment is ever in flight at a time,
  // matching the server's strictly-sequential-per-connection processing.
  let inFlight = null; // { seq, remaining: Set<lang>, expectingBinaryForLang, resolve, timer }

  function connect() {
    ws = new WebSocket(url, { headers: apiKey ? { 'x-api-key': apiKey } : {} });
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      connected = true;
      connectAttempt = 0;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        handleBinary(data);
      } else {
        handleText(data.toString());
      }
    });

    ws.on('close', () => {
      connected = false;
      failInFlight(new Error('gpu-service WebSocket closed'));
      if (closedByUs) return;
      connectAttempt++;
      setTimeout(connect, Math.min(1000 * 2 ** connectAttempt, 15000));
    });

    ws.on('error', () => {
      // 'close' fires right after in ws's implementation — reconnect handled there.
    });
  }

  function handleText(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!inFlight || msg.seq !== inFlight.seq) return; // stale/unexpected — ignore

    if (msg.type === 'error') {
      // Segment-level failure (e.g. transcription itself threw) — every
      // still-pending language for this segment fails together.
      for (const lang of inFlight.remaining) {
        onLanguageResult(lang, { ok: false, error: msg.message }, null);
      }
      resolveInFlight();
      return;
    }

    if (msg.type === 'result') {
      if (msg.ok && msg.audio_bytes > 0) {
        // Binary audio for this language follows immediately — stash which
        // language it belongs to and wait for it before marking done.
        inFlight.expectingBinaryForLang = { lang: msg.language, meta: msg };
      } else {
        inFlight.remaining.delete(msg.language);
        onLanguageResult(msg.language, msg, null);
        maybeResolve();
      }
    }
  }

  function handleBinary(buf) {
    const pending = inFlight?.expectingBinaryForLang;
    if (!pending) return; // unexpected binary frame — ignore
    inFlight.expectingBinaryForLang = null;
    inFlight.remaining.delete(pending.lang);
    onLanguageResult(pending.lang, pending.meta, buf);
    maybeResolve();
  }

  function maybeResolve() {
    if (inFlight && inFlight.remaining.size === 0) resolveInFlight();
  }

  function resolveInFlight() {
    if (!inFlight) return;
    clearTimeout(inFlight.timer);
    const { resolve } = inFlight;
    inFlight = null;
    resolve();
  }

  function failInFlight(err) {
    if (!inFlight) return;
    for (const lang of inFlight.remaining) {
      onLanguageResult(lang, { ok: false, error: err.message }, null);
    }
    resolveInFlight();
  }

  /**
   * Send one chunk for processing. Resolves once every target language has
   * reported a result (success or failure) or the timeout elapses — callers
   * must await this before sending the next chunk (see chunker.js's caller
   * in pipeline.js).
   */
  function sendSegment(seq, targetLangs, sourceLangHint, wavBuffer) {
    if (!connected || inFlight) {
      return Promise.resolve(); // not ready / already busy — caller drops this chunk
    }
    return new Promise((resolve) => {
      inFlight = {
        seq,
        remaining: new Set(targetLangs),
        expectingBinaryForLang: null,
        resolve,
        timer: setTimeout(() => failInFlight(new Error('gpu /process timed out')), timeoutMs),
      };
      if (targetLangs.length === 0) {
        resolveInFlight();
        return;
      }
      ws.send(JSON.stringify({ type: 'segment', seq, target_langs: targetLangs, source_lang_hint: sourceLangHint }));
      ws.send(wavBuffer);
    });
  }

  connect();

  return {
    sendSegment,
    get connected() {
      return connected;
    },
    get busy() {
      return inFlight !== null;
    },
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}

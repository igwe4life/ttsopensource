# Scaling from ~100 to 500-1000+ languages

Nothing in the architecture requires a rewrite to grow the registry — the
things that need to change are enumerated here, in rollout order, matching
the `priority` tiers in `language-registry/languages.json`.

## Tier 1 (~20 languages) → Tier 2 (~45) → Tier 3 (long tail, 500-1000+)

`scripts/build-registry.js`'s `TIER_1`/`TIER_2` sets define this today.
Moving a language from Tier 3 to production readiness is a **data change**:
run `scripts/verify-models.js`, confirm real checkpoints, add/adjust an
`overrides.json` entry (or fix the coverage table if the checkpoint code was
wrong), never touch application code.

## What scales for free

- **STT**: Whisper large-v3's 99 languages are ALL served by the one loaded
  model (`gpu-service/app/engines/stt/faster_whisper_engine.py`). Adding
  language #500 that Whisper already covers costs zero additional GPU memory
  or code.
- **Translation**: NLLB-200 covers 200 languages from ONE loaded model.
  Same story — most of the path to 200 languages is already "free" once
  NLLB is loaded.
- **Model routing**: `app/routing/model_pool.py`'s LRU eviction already
  assumes far more languages exist than can be resident in VRAM at once —
  this was designed for hundreds of MMS-TTS/Marian entries from the start,
  not retrofitted.

## What needs real work past ~200 languages

1. **STT beyond Whisper's 99.** `docs/ARCHITECTURE.md`'s registry marks
   `stt_fallback: "mms-asr"` for languages Whisper doesn't cover, but
   `MMSTTSEngine`'s ASR counterpart (`facebook/mms-1b-all`, a single
   multilingual CTC model covering 1000+ languages for RECOGNITION) is not
   yet wired into `app/engines/stt/`. This is the single highest-leverage
   next step for the 500+ push: one more shared model, same "one model, many
   languages" pattern as Whisper and NLLB, not a per-language model.
   Add `app/engines/stt/mms_asr_engine.py` implementing `SpeechToTextEngine`,
   register it in `model_router.py` as the fallback when
   `entry.whisper_code is None`.
2. **Translation beyond NLLB's 200.** For languages outside FLORES-200,
   options in rough preference order: (a) a community NLLB fine-tune for
   that language if one exists on HuggingFace, (b) pivot translation through
   a related, NLLB-covered language, (c) a dedicated Marian/OPUS-MT pair if
   one exists. None of this needs new abstractions — `TranslationEngine`
   already supports adding a fourth concrete engine.
3. **TTS long tail.** MMS-TTS's 1107 checkpoints are already the primary
   answer here (see `MMSTTSEngine`) — the work is verification
   (`scripts/verify-models.js`, with an authenticated HF token to clear
   rate-limit-induced unknowns — see docs/LANGUAGE_COVERAGE.md) and listening
   tests, not new code.
4. **Voice quality for Tier 3 languages.** MMS-TTS is intentionally never
   auto-promoted past `quality_level: "limited"` even when verified present —
   promoting to `"available"`/`"high"` should require an actual human
   listening pass, recorded as a manual `overrides.json` edit with a note,
   not a script flipping a flag.
5. **Registry scale.** At 500-1000 entries, `languages.json` is still a
   single JSON file well under a size that matters (each entry is ~15 short
   fields; 1000 entries is a few hundred KB) — no database migration needed
   for the registry itself. If the number of *simultaneously verified*
   overrides grows large, consider splitting `overrides.json` by tier, but
   this is a "when it's actually a problem" concern, not a v1 one.

## What does NOT need to change

- The `/process` API shape (`gpu-service/app/main.py`) — it already takes an
  arbitrary list of target languages.
- `sharedPipelineManager.js` — ref-counting by language code has no
  hard-coded limit.
- The Docker/RunPod/Hyperstack deployment story — more languages means more
  *concurrently active* model memory, which is a horizontal-scaling question
  (more GPU workers behind `orchestrator`'s `GPU_SERVICE_POOL`), not an
  architecture change.

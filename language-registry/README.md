# language-registry

The single source of truth for which languages the system supports, and at
what confidence level. Both `gpu-service` (Python) and `orchestrator` (Node)
load `languages.json` directly — there is no second copy to drift out of sync.

- `languages.json` — generated data. **Do not hand-edit** entries; edit the
  coverage tables in `scripts/build-registry.js` (repo root `scripts/`) and
  regenerate with `node scripts/build-registry.js`. Manual overrides for a
  single language (e.g. after verifying an MMS checkpoint) go in
  `overrides.json` (see below), not directly in `languages.json`.
- `schema.json` — JSON Schema for one entry. Validate with
  `node scripts/verify-models.js --schema-only` or any JSON Schema tool.
- `overrides.json` (optional, created on demand) — a small map of
  `language_code -> partial fields` merged on top of the generated entry after
  manual verification, e.g. flipping `enabled: true` and `quality_level: "medium"`
  once a real MMS-TTS checkpoint has been downloaded and test-synthesized.

## Why generated, not hand-written

With ~100 languages today and a stated goal of 500-1000+, hand-maintaining a
JSON array invites exactly the failure mode the project brief warns against:
claiming support a model doesn't actually have. `build-registry.js` encodes
coverage as named tables (`WHISPER_LANGS`, `NLLB_CODES`, `PIPER_VOICES`,
`XTTS_LANGS`, `MMS_TTS_CODES`, ...) so:

1. Adding a language is a data change, not new logic.
2. STT / translation / TTS support are computed independently per language,
   so "STT yes, translation yes, TTS experimental" falls out naturally instead
   of needing to be remembered.
3. Anything not backed by a real model table entry is `unsupported` by
   construction — there's no way to accidentally mark a language `available`
   without a matching entry in a coverage table.

## Fields

See `schema.json`. Summary:

| Field | Meaning |
|---|---|
| `stt_supported` / `stt_fallback` | Whisper large-v3 covers 99 languages; anything else falls back to an MMS-ASR checkpoint (experimental, not yet wired into the STT engine — see `docs/ROADMAP_500_1000_LANGUAGES.md`). |
| `translation_supported` / `nllb_code` | NLLB-200 covers 200 languages via FLORES-200 codes. `translation_fallback: "opus-mt"` marks languages with a known `Helsinki-NLP/opus-mt-en-<lang>` checkpoint as a secondary route. |
| `tts_supported` / `tts_engine` | Routing preference is Piper (curated, high quality) → XTTS v2 (17 languages, voice-cloning, heavier GPU cost) → MMS-TTS (1107-language coverage, robotic quality, marked `experimental` until verified). |
| `status` | Computed rollup for the UI: `available`, `limited`, `experimental`, `unsupported`. Never "available" unless every required stage is solid. |
| `enabled` | Whether the language is actually exposed to viewers. A language can have `status: experimental` and still be manually enabled once verified — see `overrides.json`. |
| `priority` | 1 = initial rollout (~20 languages), 2 = next wave (~45), 3 = long tail (the 500-1000+ expansion path). |

## Regenerating

```bash
node scripts/build-registry.js
```

This overwrites `languages.json` from the coverage tables. If you've verified
an MMS checkpoint or added a real Piper voice filename, update the relevant
table in `build-registry.js` (not `languages.json` directly) so the change
survives the next regeneration.

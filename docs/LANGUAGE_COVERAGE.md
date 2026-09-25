# Language coverage — what's real vs. what needs verification

Generated snapshot (`node scripts/build-registry.js`): **106 languages**,
computed independently per stage:

| Status | Count | Meaning |
|---|---|---|
| `available` | 41 | STT (Whisper) + translation (NLLB) + TTS (Piper/XTTS, high quality) all solid |
| `limited` | varies (grows as `verify-models.js` confirms more) | Works, but TTS quality is the MMS-TTS long-tail engine, not a curated voice |
| `experimental` | remainder | Missing Whisper coverage (falls back to an unimplemented MMS-ASR stub) and/or an unverified MMS-TTS checkpoint |
| `unsupported` | 34 | A required stage (usually translation or TTS) has no model at all — never silently claimed |

Regenerate with `node scripts/build-registry.js`; see
`language-registry/README.md` for why this is generated, not hand-written.

## The explicitly-requested African languages (section 8)

| Language | STT (Whisper) | Translation (NLLB) | TTS |
|---|---|---|---|
| Yoruba (yo) | yes | yes (`yor_Latn`) | MMS-TTS, **verified present** (`facebook/mms-tts-yor`) |
| Igbo (ig) | no — MMS-ASR fallback (unimplemented) | yes (`ibo_Latn`) | MMS-TTS, unverified in this run (rate-limited, not confirmed absent) |
| Hausa (ha) | yes | yes (`hau_Latn`) | MMS-TTS, **verified present** (`facebook/mms-tts-hau`) |
| Swahili (sw) | yes | yes (`swh_Latn`) | **Piper** (`sw_CD-lanfrica-medium`) — highest quality tier |
| Amharic (am) | yes | yes (`amh_Ethi`) | MMS-TTS, **verified present** |
| Zulu (zu) | no | yes (`zul_Latn`) | MMS-TTS, unverified this run |
| Xhosa (xh) | no | yes (`xho_Latn`) | MMS-TTS, unverified this run |
| Shona (sn) | yes | yes (`sna_Latn`) | MMS-TTS, **verified present** |
| Somali (so) | yes | yes (`som_Latn`) | MMS-TTS, **verified present** |
| Akan/Twi (tw) | no | yes (`aka_Latn`) | MMS-TTS, **verified present** (`facebook/mms-tts-aka`) |
| Wolof (wo) | no | yes (`wol_Latn`) | MMS-TTS, unverified this run |
| Lingala (ln) | yes | yes (`lin_Latn`) | MMS-TTS, unverified this run |
| Kinyarwanda (rw) | no | yes (`kin_Latn`) | MMS-TTS, **verified present** |
| Fula/Fulfulde (ff) | no | yes (`fuv_Latn`\*) | MMS-TTS, **verified present** (`facebook/mms-tts-ful`) |

\* NLLB's Fulfulde code is Nigerian Fulfulde specifically (`fuv_Latn`); Fula
has multiple regional varieties NLLB doesn't fully distinguish — flagged in
that entry's `notes`.

Every one of these has real translation coverage via NLLB-200. TTS is where
the "do not force one model to handle every language" principle earns its
keep: Swahili gets a genuinely high-quality Piper voice, several others get a
**verified** MMS-TTS checkpoint, and a few remain honestly `experimental`
pending either verification or STT coverage via a future MMS-ASR integration
(see roadmap doc). None of them are silently marked "available" without
backing.

## A real finding from running scripts/verify-models.js against this data

Running the verifier against HuggingFace's API surfaced two things worth
recording so the mistake isn't repeated:

1. **Anonymous HF API calls rate-limit hard** (roughly the first ~60 calls in
   a short window succeed, the rest come back `401`, not `404`). An earlier,
   naive version of this script treated ANY non-200 response as "model
   missing" and would have auto-disabled dozens of languages that are
   actually fine — including well-known models like
   `Helsinki-NLP/opus-mt-en-ja`, which definitely exists. **Only a `404` is
   evidence of absence; `401`/`403`/`429` mean "inconclusive," not "missing."**
   `scripts/verify-models.js` was fixed to make that distinction before it
   was trusted for anything.
2. With that fix, a full run found **zero confirmed-missing** models among
   the 105 checked, 59 confirmed present (see
   `language-registry/overrides.json` for the languages whose MMS-TTS
   checkpoint verification upgraded them from `experimental` to `limited`),
   and 46 inconclusive due to rate limiting. **Run it again with an
   authenticated HF token** (`huggingface-cli login` then re-run, or pass a
   token — not yet wired into the script; a good first follow-up task) to
   clear the remaining unknowns before a production rollout.

This is the intended workflow going forward: `build-registry.js` encodes
*claims*, `verify-models.js` checks them against reality, and
`overrides.json` records what's actually been confirmed — never edit
`quality_level`/`enabled` in `languages.json` by hand.

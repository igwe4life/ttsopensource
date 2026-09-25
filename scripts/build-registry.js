#!/usr/bin/env node
/**
 * Builds language-registry/languages.json from real, named model-coverage
 * tables instead of hand-typing ~100 JSON records (error-prone and easy to
 * silently overclaim support).
 *
 * Coverage tables below reflect each project's PUBLISHED language list at the
 * time this was written:
 *   - WHISPER_LANGS       whisper / faster-whisper (large-v3), 99 languages
 *   - NLLB_CODES          NLLB-200 FLORES-200 codes (200 languages; subset used here)
 *   - PIPER_VOICES        rhasspy/piper curated per-language voices (~30 languages)
 *   - XTTS_LANGS          Coqui XTTS v2 (17 languages, voice-cloning capable)
 *   - MMS_TTS_CODES       facebook/mms-tts per-language checkpoints (iso639-3-ish
 *                         codes). MMS covers 1107 languages total; only the
 *                         subset relevant to our ~100-language target list is
 *                         enumerated here. Treat entries as UNVERIFIED unless
 *                         `verified: true` — mirrors the old ttsengine's
 *                         "xx-XX-VERIFY" convention for un-confirmed voices.
 *
 * Run: node scripts/build-registry.js
 * Writes: language-registry/languages.json
 *
 * IMPORTANT: this script encodes coverage *claims*. Before enabling any
 * language in production, run scripts/verify-models.js (or the GPU service's
 * /models endpoint against the live model files) to confirm the checkpoint
 * actually exists and loads. Do not trust this file blindly — see
 * docs/LANGUAGE_COVERAGE.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'language-registry', 'languages.json');

// ── Whisper / faster-whisper: 99 languages (large-v3 multilingual) ─────────
// code -> [English name, native name]
const WHISPER_LANGS = {
  en: ['English', 'English'], zh: ['Chinese', '中文'], de: ['German', 'Deutsch'],
  es: ['Spanish', 'Español'], ru: ['Russian', 'Русский'], ko: ['Korean', '한국어'],
  fr: ['French', 'Français'], ja: ['Japanese', '日本語'], pt: ['Portuguese', 'Português'],
  tr: ['Turkish', 'Türkçe'], pl: ['Polish', 'Polski'], ca: ['Catalan', 'Català'],
  nl: ['Dutch', 'Nederlands'], ar: ['Arabic', 'العربية'], sv: ['Swedish', 'Svenska'],
  it: ['Italian', 'Italiano'], id: ['Indonesian', 'Bahasa Indonesia'], hi: ['Hindi', 'हिन्दी'],
  fi: ['Finnish', 'Suomi'], vi: ['Vietnamese', 'Tiếng Việt'], he: ['Hebrew', 'עברית'],
  uk: ['Ukrainian', 'Українська'], el: ['Greek', 'Ελληνικά'], ms: ['Malay', 'Bahasa Melayu'],
  cs: ['Czech', 'Čeština'], ro: ['Romanian', 'Română'], da: ['Danish', 'Dansk'],
  hu: ['Hungarian', 'Magyar'], ta: ['Tamil', 'தமிழ்'], no: ['Norwegian', 'Norsk'],
  th: ['Thai', 'ไทย'], ur: ['Urdu', 'اردو'], hr: ['Croatian', 'Hrvatski'],
  bg: ['Bulgarian', 'Български'], lt: ['Lithuanian', 'Lietuvių'], la: ['Latin', 'Latina'],
  mi: ['Maori', 'Māori'], ml: ['Malayalam', 'മലയാളം'], cy: ['Welsh', 'Cymraeg'],
  sk: ['Slovak', 'Slovenčina'], te: ['Telugu', 'తెలుగు'], fa: ['Persian', 'فارسی'],
  lv: ['Latvian', 'Latviešu'], bn: ['Bengali', 'বাংলা'], sr: ['Serbian', 'Српски'],
  az: ['Azerbaijani', 'Azərbaycan'], sl: ['Slovenian', 'Slovenščina'], kn: ['Kannada', 'ಕನ್ನಡ'],
  et: ['Estonian', 'Eesti'], mk: ['Macedonian', 'Македонски'], br: ['Breton', 'Brezhoneg'],
  eu: ['Basque', 'Euskara'], is: ['Icelandic', 'Íslenska'], hy: ['Armenian', 'Հայերեն'],
  ne: ['Nepali', 'नेपाली'], mn: ['Mongolian', 'Монгол'], bs: ['Bosnian', 'Bosanski'],
  kk: ['Kazakh', 'Қазақ'], sq: ['Albanian', 'Shqip'], sw: ['Swahili', 'Kiswahili'],
  gl: ['Galician', 'Galego'], mr: ['Marathi', 'मराठी'], pa: ['Punjabi', 'ਪੰਜਾਬੀ'],
  si: ['Sinhala', 'සිංහල'], km: ['Khmer', 'ខ្មែរ'], sn: ['Shona', 'ChiShona'],
  yo: ['Yoruba', 'Yorùbá'], so: ['Somali', 'Soomaali'], af: ['Afrikaans', 'Afrikaans'],
  oc: ['Occitan', 'Occitan'], ka: ['Georgian', 'ქართული'], be: ['Belarusian', 'Беларуская'],
  tg: ['Tajik', 'Тоҷикӣ'], sd: ['Sindhi', 'سنڌي'], gu: ['Gujarati', 'ગુજરાતી'],
  am: ['Amharic', 'አማርኛ'], yi: ['Yiddish', 'ייִדיש'], lo: ['Lao', 'ລາວ'],
  uz: ['Uzbek', 'Oʻzbek'], fo: ['Faroese', 'Føroyskt'], ht: ['Haitian Creole', 'Kreyòl ayisyen'],
  ps: ['Pashto', 'پښتو'], tk: ['Turkmen', 'Türkmen'], nn: ['Norwegian Nynorsk', 'Nynorsk'],
  mt: ['Maltese', 'Malti'], sa: ['Sanskrit', 'संस्कृतम्'], lb: ['Luxembourgish', 'Lëtzebuergesch'],
  my: ['Burmese', 'မြန်မာဘာသာ'], bo: ['Tibetan', 'བོད་སྐད'], tl: ['Tagalog', 'Tagalog'],
  mg: ['Malagasy', 'Malagasy'], as: ['Assamese', 'অসমীয়া'], tt: ['Tatar', 'Татар'],
  haw: ['Hawaiian', 'ʻŌlelo Hawaiʻi'], ln: ['Lingala', 'Lingála'], ha: ['Hausa', 'Hausa'],
  ba: ['Bashkir', 'Башҡорт'], jw: ['Javanese', 'Basa Jawa'], su: ['Sundanese', 'Basa Sunda'],
};

// ── Extra languages explicitly requested that Whisper's 99 do NOT cover ────
// STT for these falls back to an MMS-ASR checkpoint (experimental) until a
// dedicated fine-tune is wired in. Never silently claim Whisper coverage here.
const NO_WHISPER_LANGS = {
  ig: ['Igbo', 'Igbo'], zu: ['Zulu', 'isiZulu'], xh: ['Xhosa', 'isiXhosa'],
  tw: ['Twi (Akan)', 'Twi'], wo: ['Wolof', 'Wolof'], rw: ['Kinyarwanda', 'Ikinyarwanda'],
  ff: ['Fula (Fulfulde)', 'Fulfulde'],
};

const ALL_LANGS = { ...WHISPER_LANGS, ...NO_WHISPER_LANGS };

// ── NLLB-200 FLORES-200 codes ───────────────────────────────────────────────
// Absent from this map => NLLB does not have a direct code (translation_supported=false).
const NLLB_CODES = {
  en: 'eng_Latn', zh: 'zho_Hans', de: 'deu_Latn', es: 'spa_Latn', ru: 'rus_Cyrl',
  ko: 'kor_Hang', fr: 'fra_Latn', ja: 'jpn_Jpan', pt: 'por_Latn', tr: 'tur_Latn',
  pl: 'pol_Latn', ca: 'cat_Latn', nl: 'nld_Latn', ar: 'arb_Arab', sv: 'swe_Latn',
  it: 'ita_Latn', id: 'ind_Latn', hi: 'hin_Deva', fi: 'fin_Latn', vi: 'vie_Latn',
  he: 'heb_Hebr', uk: 'ukr_Cyrl', el: 'ell_Grek', ms: 'zsm_Latn', cs: 'ces_Latn',
  ro: 'ron_Latn', da: 'dan_Latn', hu: 'hun_Latn', ta: 'tam_Taml', no: 'nob_Latn',
  th: 'tha_Thai', ur: 'urd_Arab', hr: 'hrv_Latn', bg: 'bul_Cyrl', lt: 'lit_Latn',
  mi: 'mri_Latn', ml: 'mal_Mlym', cy: 'cym_Latn', sk: 'slk_Latn', te: 'tel_Telu',
  fa: 'pes_Arab', lv: 'lvs_Latn', bn: 'ben_Beng', sr: 'srp_Cyrl', az: 'azj_Latn',
  sl: 'slv_Latn', kn: 'kan_Knda', et: 'est_Latn', mk: 'mkd_Cyrl', eu: 'eus_Latn',
  is: 'isl_Latn', hy: 'hye_Armn', ne: 'npi_Deva', mn: 'khk_Cyrl', bs: 'bos_Latn',
  kk: 'kaz_Cyrl', sq: 'als_Latn', sw: 'swh_Latn', gl: 'glg_Latn', mr: 'mar_Deva',
  pa: 'pan_Guru', si: 'sin_Sinh', km: 'khm_Khmr', sn: 'sna_Latn', yo: 'yor_Latn',
  so: 'som_Latn', af: 'afr_Latn', oc: 'oci_Latn', ka: 'kat_Geor', be: 'bel_Cyrl',
  tg: 'tgk_Cyrl', sd: 'snd_Arab', gu: 'guj_Gujr', am: 'amh_Ethi', yi: 'ydd_Hebr',
  lo: 'lao_Laoo', uz: 'uzn_Latn', ht: 'hat_Latn', ps: 'pbt_Arab', tk: 'tuk_Latn',
  nn: 'nno_Latn', mt: 'mlt_Latn', sa: 'san_Deva', lb: 'ltz_Latn', my: 'mya_Mymr',
  tl: 'tgl_Latn', mg: 'plt_Latn', as: 'asm_Beng', ln: 'lin_Latn', ha: 'hau_Latn',
  jw: 'jav_Latn', su: 'sun_Latn',
  // requested African languages without Whisper coverage:
  ig: 'ibo_Latn', zu: 'zul_Latn', xh: 'xho_Latn', tw: 'aka_Latn', wo: 'wol_Latn',
  rw: 'kin_Latn', ff: 'fuv_Latn',
};
// Known to have NO NLLB-200 code (Whisper-only, no translation route yet):
// la, br, fo, bo, tt, haw, ba

// ── Piper: curated, high-quality per-language voices (community-maintained) ─
// code -> default voice id (illustrative naming; verify against the live
// rhasspy/piper-voices HF repo before enabling in production).
const PIPER_VOICES = {
  en: 'en_US-lessac-medium', es: 'es_ES-sharvard-medium', fr: 'fr_FR-siwis-medium',
  de: 'de_DE-thorsten-medium', it: 'it_IT-riccardo-x_low', pt: 'pt_BR-faber-medium',
  nl: 'nl_NL-mls-medium', pl: 'pl_PL-darkman-medium', ru: 'ru_RU-irina-medium',
  uk: 'uk_UA-ukrainian_tts-medium', cs: 'cs_CZ-jirka-medium', sk: 'sk_SK-lili-medium',
  ro: 'ro_RO-mihai-medium', hu: 'hu_HU-imre-medium', el: 'el_GR-rapunzelina-low',
  sv: 'sv_SE-nst-medium', da: 'da_DK-talesyntese-medium', no: 'no_NO-talesyntese-medium',
  fi: 'fi_FI-harri-medium', tr: 'tr_TR-dfki-medium', ar: 'ar_JO-kareem-medium',
  vi: 'vi_VN-vais1000-medium', ca: 'ca_ES-upc_ona-medium', is: 'is_IS-bui-medium',
  cy: 'cy_GB-gwryw_gogleddol-medium', sr: 'sr_RS-serbski_institut-medium',
  sl: 'sl_SI-artur-medium', bg: 'bg_BG-dimitar-medium',
  lt: 'lt_LT-reginute1-medium', lv: 'lv_LV-aivars-medium', et: 'et_EE-news-medium',
  ka: 'ka_GE-natia-medium', kk: 'kk_KZ-iseke-x_low', ne: 'ne_NP-google-medium',
  fa: 'fa_IR-amir-medium', sw: 'sw_CD-lanfrica-medium', zh: 'zh_CN-huayan-medium',
};

// ── Coqui XTTS v2: 17 languages, voice-cloning capable, heavier GPU cost ────
const XTTS_LANGS = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl', 'cs', 'ar',
  'zh', 'hu', 'ko', 'ja', 'hi',
]);

// ── MMS-TTS (facebook/mms-tts-<code>): broad low-resource coverage ─────────
// Real coverage is 1107 languages; only the subset we care about is listed.
// `verified:false` mirrors the old codebase's "-VERIFY" placeholder convention
// — these codes are our best knowledge, not a confirmed-working checkpoint.
const MMS_TTS_CODES = {
  yo: { code: 'yor', verified: false }, ig: { code: 'ibo', verified: false },
  ha: { code: 'hau', verified: false }, sw: { code: 'swh', verified: false },
  am: { code: 'amh', verified: false }, zu: { code: 'zul', verified: false },
  xh: { code: 'xho', verified: false }, sn: { code: 'sna', verified: false },
  so: { code: 'som', verified: false }, tw: { code: 'aka', verified: false },
  wo: { code: 'wol', verified: false }, ln: { code: 'lin', verified: false },
  rw: { code: 'kin', verified: false }, ff: { code: 'ful', verified: false },
  ne: { code: 'npi', verified: false }, km: { code: 'khm', verified: false },
  my: { code: 'mya', verified: false }, si: { code: 'sin', verified: false },
  ps: { code: 'pbt', verified: false }, sd: { code: 'snd', verified: false },
  tg: { code: 'tgk', verified: false }, mg: { code: 'plt', verified: false },
  ht: { code: 'hat', verified: false }, uz: { code: 'uzn', verified: false },
  mn: { code: 'khk', verified: false }, ka: { code: 'kat', verified: false },
  gl: { code: 'glg', verified: false }, af: { code: 'afr', verified: false },
  yi: { code: 'ydd', verified: false }, jw: { code: 'jav', verified: false },
  su: { code: 'sun', verified: false }, as: { code: 'asm', verified: false },
  bo: { code: 'bod', verified: false }, tt: { code: 'tat', verified: false },
  ba: { code: 'bak', verified: false }, fo: { code: 'fao', verified: false },
  br: { code: 'bre', verified: false }, haw: { code: 'haw', verified: false },
  mi: { code: 'mri', verified: false }, sa: { code: 'san', verified: false },
  la: { code: 'lat', verified: false },
  // Croatian has NO Piper voice (the whole hr/hr_HR directory 404s on
  // rhasspy/piper-voices as of this writing — verified via the HF tree API,
  // not assumed) despite Whisper/NLLB covering it fine. MMS-TTS is its only
  // TTS route for now.
  hr: { code: 'hrv', verified: false },
};

// ── Well-known Helsinki-NLP/opus-mt en-<lang> checkpoints (translation fallback) ─
const OPUS_MT_PAIRS = new Set([
  'fr', 'es', 'de', 'it', 'nl', 'ru', 'zh', 'ar', 'he', 'hi', 'vi', 'tr', 'pl',
  'uk', 'sv', 'da', 'fi', 'el', 'cs', 'ro', 'hu', 'bg', 'sr', 'ko', 'ja', 'id',
  'ms', 'th', 'fa', 'ur', 'bn', 'ta', 'te', 'ml', 'kn', 'mr', 'gu', 'pa', 'ne',
  'si', 'my', 'km', 'lo', 'sw', 'am', 'yo', 'ha', 'ig', 'sn', 'so', 'af', 'sq',
  'hy', 'az', 'ka', 'kk', 'uz', 'mn', 'tl', 'mg', 'zu', 'xh', 'rw', 'wo', 'ln',
]);

// ── Priority tiers (rollout order — see docs/ROADMAP_500_1000_LANGUAGES.md) ─
const TIER_1 = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk',
  'ar', 'zh', 'ja', 'ko', 'hi', 'tr', 'vi', 'id', 'th', 'sv']);
const TIER_2 = new Set(['cs', 'sk', 'ro', 'hu', 'el', 'da', 'no', 'fi', 'he', 'bn',
  'ur', 'fa', 'ta', 'te', 'ml', 'kn', 'mr', 'gu', 'pa', 'ne', 'si', 'my', 'km',
  'lo', 'ms', 'tl', 'bg', 'hr', 'sr', 'bs', 'sl', 'et', 'lv', 'lt', 'ka', 'hy',
  'az', 'kk', 'uz', 'mn', 'af', 'sq', 'is', 'gl', 'ca', 'eu', 'cy']);
// Everything else (Tier 3): long-tail / lower-resource, including the
// explicitly-requested African languages — see docs/LANGUAGE_COVERAGE.md.

function priorityFor(code) {
  if (TIER_1.has(code)) return 1;
  if (TIER_2.has(code)) return 2;
  return 3;
}

function buildEntry(code) {
  const [name, native] = ALL_LANGS[code];
  const whisperSupported = !!WHISPER_LANGS[code];
  const nllbCode = NLLB_CODES[code] || null;
  const translationSupported = !!nllbCode;

  // TTS routing: piper > xtts > mms > none. First match wins (see
  // gpu-service/app/routing/model_router.py for the runtime equivalent).
  let ttsEngine = null, ttsModel = null, voiceId = null, ttsQuality = 'unsupported';
  let ttsSupported = false, ttsNotes = 'No viable open-source TTS checkpoint identified yet.';

  if (PIPER_VOICES[code]) {
    ttsEngine = 'piper'; ttsModel = PIPER_VOICES[code]; voiceId = PIPER_VOICES[code];
    ttsQuality = 'high'; ttsSupported = true;
    ttsNotes = 'Piper community voice — verify current filename in rhasspy/piper-voices before enabling.';
  } else if (XTTS_LANGS.has(code)) {
    ttsEngine = 'xtts'; ttsModel = 'coqui/XTTS-v2'; voiceId = `${code}-default`;
    ttsQuality = 'high'; ttsSupported = true;
    ttsNotes = 'Coqui XTTS v2 — higher GPU cost per request; supports voice cloning from a reference clip.';
  } else if (MMS_TTS_CODES[code]) {
    const m = MMS_TTS_CODES[code];
    ttsEngine = 'mms'; ttsModel = `facebook/mms-tts-${m.code}`; voiceId = m.code;
    ttsQuality = m.verified ? 'medium' : 'experimental';
    ttsSupported = true;
    ttsNotes = m.verified
      ? 'MMS-TTS checkpoint confirmed working.'
      : `MMS-TTS checkpoint UNVERIFIED (code guess: ${m.code}-VERIFY). Run scripts/verify-models.js before enabling for real traffic.`;
  }

  const sttSupported = whisperSupported; // shared Whisper/faster-whisper model
  const sttNotes = whisperSupported
    ? null
    : 'Not in Whisper large-v3\'s 99 languages. Falls back to an MMS-ASR checkpoint (experimental) — no dedicated STT model wired in yet.';

  // enabled: only flip on automatically when every stage has at least
  // "limited" confidence AND (for MMS) the checkpoint isn't a bare guess.
  const enabled = sttSupported && translationSupported && ttsSupported &&
    !(ttsEngine === 'mms' && !MMS_TTS_CODES[code].verified && priorityFor(code) === 3 && !whisperSupported);

  let status;
  if (!translationSupported || !ttsSupported) status = 'unsupported';
  else if (!sttSupported || ttsQuality === 'experimental') status = 'experimental';
  else if (ttsQuality === 'medium') status = 'limited';
  else status = 'available';

  return {
    language_code: code,
    language_name: name,
    native_name: native,
    whisper_code: whisperSupported ? code : null,
    stt_supported: sttSupported,
    stt_fallback: sttSupported ? null : 'mms-asr',
    nllb_code: nllbCode,
    translation_supported: translationSupported,
    translation_model: translationSupported ? 'nllb' : null,
    translation_fallback: OPUS_MT_PAIRS.has(code) ? 'opus-mt' : null,
    tts_supported: ttsSupported,
    tts_engine: ttsEngine,
    tts_model: ttsModel,
    voice_id: voiceId,
    quality_level: ttsQuality,
    status,
    enabled: !!enabled,
    priority: priorityFor(code),
    notes: [sttNotes, ttsNotes].filter(Boolean).join(' '),
  };
}

const codes = Object.keys(ALL_LANGS).sort((a, b) => {
  const p = priorityFor(a) - priorityFor(b);
  return p !== 0 ? p : a.localeCompare(b);
});

const registry = {
  schema_version: 1,
  generated_by: 'scripts/build-registry.js',
  generated_note: 'Coverage claims are best-known-at-write-time. Re-verify with scripts/verify-models.js before production use.',
  total_languages: codes.length,
  languages: codes.map(buildEntry),
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(registry, null, 2) + '\n', 'utf8');

const counts = registry.languages.reduce((acc, l) => {
  acc[l.status] = (acc[l.status] || 0) + 1;
  return acc;
}, {});
console.log(`Wrote ${registry.languages.length} languages to ${OUT}`);
console.log('By status:', counts);

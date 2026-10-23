#!/usr/bin/env node
/**
 * Applies the 100-language "pool" set to language-registry/languages.json:
 * routes each language to a TTS voice that was verified to exist on
 * HuggingFace (HTTP 200 on the real file), adds languages the registry did not
 * know about yet (mostly African), and writes language-registry/pool-languages.json
 * (the ordered list of 100 codes the orchestrator broadcasts).
 *
 * Idempotent: run it as many times as you like. It edits languages.json in
 * place — if you regenerate that file with scripts/build-registry.js, run this
 * afterwards to re-apply the pool set.
 *
 * Run: node scripts/add-pool-languages.js
 *
 * Voice sources:
 *   - Piper (rhasspy/piper-voices): high-quality ONNX voices, `tts_model` =
 *     voice id, file path derived as <lang>/<locale>/<name>/<quality>/<id>.onnx.
 *   - MMS-TTS (facebook/mms-tts-<code>): long-tail VITS checkpoints. LICENSE:
 *     CC-BY-NC 4.0 (non-commercial) — check this before commercial use.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..', 'language-registry');
const REG = path.join(DIR, 'languages.json');
const POOL = path.join(DIR, 'pool-languages.json');

// ── Piper voices verified present (HTTP 200) — only the ones the registry
// did NOT already route to Piper. Already-routed Piper languages (ar bg ca cs
// cy da de el es et fa fi fr hu is it ka kk lv ne nl no pl pt ro ru sk sl sr sv
// sw tr uk vi zh) are untouched.
//
// NOT used even though a Piper voice exists: lt, th, he, ja. Those voices need
// special phonemizers (phoneme_type lithuanian/thai/hebrew/japanese) that the
// installed piper-tts does not support (it raised "'lithuanian' is not a valid
// PhonemeType"). th and he use MMS instead; lt and ja are replaced by ilo and war.
const PIPER_VOICES = {
  hi: 'hi_IN-pratham-medium', id: 'id_ID-news_tts-medium',
  bn: 'bn_BD-google-medium', eu: 'eu_ES-antton-medium',
  ml: 'ml_IN-arjun-medium', mr: 'mr_IN-google-medium', te: 'te_IN-maya-medium',
  sq: 'sq_AL-edon-medium', ur: 'ur_PK-fasih-medium', hy: 'hy_AM-gor-medium',
  lb: 'lb_LU-marylux-medium', ko: 'ko_KR-kss-medium',
  ku: 'ku_TR-berfin_renas-medium',
};

// ── MMS-TTS checkpoints verified present. code -> 3-letter MMS id.
const MMS_IDS = {
  // existing registry rows: fix id / enable
  mg: 'mlg', mn: 'mon', gu: 'guj', kn: 'kan', lo: 'lao', pa: 'pan', tl: 'tgl',
  az: 'azj-script_latin', ms: 'zlm', ta: 'tam', he: 'heb', th: 'tha',
  // new rows below
  ceb: 'ceb', ak: 'aka', om: 'orm', ti: 'tir', lg: 'lug', ny: 'nya', bm: 'bam', ki: 'kik',
  ee: 'ewe', ts: 'tso', rn: 'run', sag: 'sag', mos: 'mos', kab: 'kab', fon: 'fon',
  kbp: 'kbp', bem: 'bem', ay: 'ayr', gn: 'grn', qu: 'quy', ky: 'kir', ilo: 'ilo', war: 'war',
};

// Existing rows that have a voice but were missing their NLLB-200 code.
const NLLB_FIX = { fo: 'fao_Latn', tt: 'tat_Cyrl' };

// Second batch (26 more NLLB-200 languages that have an MMS voice). Appended AFTER the first 100 in
// pool-languages.json so the first 100 keep their positions — GPU pods shard by position (index mod N),
// and live pods already hold their voices under that layout.
// Not included on purpose: English (the source language), Uzbek (MMS voice is Cyrillic, NLLB writes Latin) and
// Crimean Tatar (crh: the MMS voice fails on every input — it was most likely trained on Cyrillic script).
// [code, English name, native name, NLLB code, MMS id]
const EXTRA_MMS = [
  ["ace", "Acehnese", "Bahsa Acèh", "ace_Latn", "ace"],
  ["awa", "Awadhi", "अवधी", "awa_Deva", "awa"],
  ["azb", "South Azerbaijani", "تۆرکجه", "azb_Arab", "azb"],
  ["ba", "Bashkir", "Башҡорт", "bak_Cyrl", "bak"],
  ["ban", "Balinese", "Basa Bali", "ban_Latn", "ban"],
  ["bo", "Tibetan", "བོད་སྐད", "bod_Tibt", "bod"],
  ["dik", "Southwestern Dinka", "Thuɔŋjäŋ", "dik_Latn", "dik"],
  ["dyu", "Dyula", "Julakan", "dyu_Latn", "dyu"],
  ["dz", "Dzongkha", "རྫོང་ཁ", "dzo_Tibt", "dzo"],
  ["fj", "Fijian", "Na Vosa Vakaviti", "fij_Latn", "fij"],
  ["hne", "Chhattisgarhi", "छत्तीसगढ़ी", "hne_Deva", "hne"],
  ["kac", "Jingpho (Kachin)", "Jinghpaw", "kac_Latn", "kac"],
  ["mag", "Magahi", "मगही", "mag_Deva", "mag"],
  ["mai", "Maithili", "मैथिली", "mai_Deva", "mai"],
  ["min", "Minangkabau", "Baso Minangkabau", "min_Latn", "min"],
  ["nus", "Nuer", "Thok Naath", "nus_Latn", "nus"],
  ["or", "Odia", "ଓଡ଼ିଆ", "ory_Orya", "ory"],
  ["pag", "Pangasinan", "Salitan Pangasinan", "pag_Latn", "pag"],
  ["pap", "Papiamento", "Papiamentu", "pap_Latn", "pap"],
  ["shn", "Shan", "ၵႂၢမ်းတႆး", "shn_Mymr", "shn"],
  ["sm", "Samoan", "Gagana Samoa", "smo_Latn", "smo"],
  ["taq", "Tamasheq", "Tamasheq", "taq_Latn", "taq"],
  ["tk", "Turkmen", "Türkmen", "tuk_Latn", "tuk-script_latin"],
  ["tpi", "Tok Pisin", "Tok Pisin", "tpi_Latn", "tpi"],
  ["ug", "Uyghur", "ئۇيغۇرچە", "uig_Arab", "uig-script_arabic"],
];

// New registry rows: code -> [English name, native name, NLLB code]
const NEW_ROWS = {
  ku: ['Kurdish (Kurmanji)', 'Kurdî', 'kmr_Latn'],
  ceb: ['Cebuano', 'Cebuano', 'ceb_Latn'],
  ak: ['Akan', 'Akan', 'aka_Latn'],
  om: ['Oromo', 'Afaan Oromoo', 'gaz_Latn'],
  ti: ['Tigrinya', 'ትግርኛ', 'tir_Ethi'],
  lg: ['Luganda', 'Luganda', 'lug_Latn'],
  ny: ['Chichewa', 'Chichewa', 'nya_Latn'],
  bm: ['Bambara', 'Bamanankan', 'bam_Latn'],
  ki: ['Kikuyu', 'Gĩkũyũ', 'kik_Latn'],
  ee: ['Ewe', 'Eʋegbe', 'ewe_Latn'],
  ts: ['Tsonga', 'Xitsonga', 'tso_Latn'],
  rn: ['Kirundi', 'Ikirundi', 'run_Latn'],
  sag: ['Sango', 'Sängö', 'sag_Latn'],
  mos: ['Mossi', 'Mooré', 'mos_Latn'],
  kab: ['Kabyle', 'Taqbaylit', 'kab_Latn'],
  fon: ['Fon', 'Fɔ̀ngbè', 'fon_Latn'],
  kbp: ['Kabiyè', 'Kabɩyɛ', 'kbp_Latn'],
  bem: ['Bemba', 'Ichibemba', 'bem_Latn'],
  ay: ['Aymara', 'Aymar aru', 'ayr_Latn'],
  gn: ['Guarani', "Avañe'ẽ", 'grn_Latn'],
  qu: ['Quechua', 'Runasimi', 'quy_Latn'],
  ky: ['Kyrgyz', 'Кыргызча', 'kir_Cyrl'],
  ilo: ['Ilocano', 'Ilokano', 'ilo_Latn'],
  war: ['Waray', 'Winaray', 'war_Latn'],
};

// The 100 broadcast languages, ordered so that round-robin sharding (entry i ->
// shard i % N, for N = 2 or 4) gives every shard an even mix of Piper and MMS
// voices — MMS is the slower path, so a shard of all-MMS would be the bottleneck.
// Pattern (period 8): P P M M M M P P — balanced for both 2 and 4 shards.
const PIPER_CODES = ('ar bg ca cs cy da de el es et fa fi fr hu is it ka kk lv ne nl no pl pt ro ru sk sl sr sv sw tr uk vi zh '
  + Object.keys(PIPER_VOICES).join(' ')).split(' ');
const MMS_CODES = ('am as ff fo ha ht jw km my rw sn so su tg tt tw yo ' + Object.keys(MMS_IDS).join(' ')).split(' ');
// (la, bo excluded on purpose: Latin / Tibetan are not useful broadcast targets;
// ba excluded: Bashkir is not in NLLB-200, so it cannot be translated into.)

const PATTERN = 'PPMMMMPP';

function computeStatus(e) {
  if (!e.translation_supported || !e.tts_supported) return 'unsupported';
  if (!e.stt_supported || e.quality_level === 'experimental') return 'experimental';
  if (e.quality_level === 'medium' || e.quality_level === 'limited') return 'limited';
  return 'available';
}

function applyPiper(entry, voiceId) {
  Object.assign(entry, {
    tts_supported: true, tts_engine: 'piper', tts_model: voiceId, voice_id: voiceId,
    quality_level: 'medium', enabled: true,
    notes: 'Piper voice verified present on rhasspy/piper-voices (pool build).',
  });
}
function applyMms(entry, mmsId) {
  Object.assign(entry, {
    tts_supported: true, tts_engine: 'mms', tts_model: `facebook/mms-tts-${mmsId}`, voice_id: mmsId,
    quality_level: 'limited', enabled: true,
    notes: 'MMS-TTS checkpoint verified present on HuggingFace (pool build). Robotic quality; CC-BY-NC 4.0 licence.',
  });
}

/**
 * Applies the pool set to a registry object IN PLACE and returns the ordered
 * list of broadcast codes. Deterministic, so scripts/build-registry.js can call
 * it as its last step and CI's "regenerate and diff" check keeps passing.
 */
export function applyPoolLanguages(reg) {
  const byCode = new Map(reg.languages.map((l) => [l.language_code, l]));
  for (const [code, [name, native, nllb]] of Object.entries(NEW_ROWS)) {
    if (!byCode.has(code)) {
      const row = {
        language_code: code, language_name: name, native_name: native, whisper_code: null,
        stt_supported: false, stt_fallback: null, nllb_code: nllb, translation_supported: true,
        translation_model: 'nllb', translation_fallback: null, tts_supported: false, tts_engine: null,
        tts_model: null, voice_id: null, quality_level: 'unsupported', status: 'unsupported',
        enabled: false, priority: 3, notes: '',
      };
      reg.languages.push(row);
      byCode.set(code, row);
    }
  }
  for (const [code, nllb] of Object.entries(NLLB_FIX)) {
    Object.assign(byCode.get(code), { nllb_code: nllb, translation_supported: true, translation_model: 'nllb' });
  }
  for (const [code, voice] of Object.entries(PIPER_VOICES)) applyPiper(byCode.get(code), voice);
  for (const [code, id] of Object.entries(MMS_IDS)) applyMms(byCode.get(code), id);
  // second batch: create missing rows, repair existing ones (ba, bo, tk), attach the MMS voice
  for (const [code, name, native, nllb, id] of EXTRA_MMS) {
    let row = byCode.get(code);
    if (!row) {
      row = {
        language_code: code, language_name: name, native_name: native, whisper_code: null,
        stt_supported: false, stt_fallback: null, nllb_code: nllb, translation_supported: true,
        translation_model: 'nllb', translation_fallback: null, tts_supported: false, tts_engine: null,
        tts_model: null, voice_id: null, quality_level: 'unsupported', status: 'unsupported',
        enabled: false, priority: 3, notes: '',
      };
      reg.languages.push(row);
      byCode.set(code, row);
    }
    Object.assign(row, { nllb_code: nllb, translation_supported: true, translation_model: 'nllb' });
    applyMms(row, id);
  }

  // Already-routed languages keep their route but must be enabled for broadcast.
  const ordered = [];
  const pi = [...new Set(PIPER_CODES)], mi = [...new Set(MMS_CODES)];
  for (let i = 0, a = 0, b = 0; a < pi.length || b < mi.length; i++) {
    const fromPiper = (PATTERN[i % 8] === 'P' && a < pi.length) || b >= mi.length;
    if (fromPiper) ordered.push(pi[a++]); else ordered.push(mi[b++]);
  }
  const problems = [];
  for (const code of ordered) {
    const e = byCode.get(code);
    if (!e) { problems.push(`${code}: not in registry`); continue; }
    if (!e.tts_supported) problems.push(`${code}: no TTS route`);
    if (!e.nllb_code) problems.push(`${code}: no NLLB code`);
    e.enabled = true;
  }
  // second batch goes last, so positions 0..99 never change
  for (const [code] of EXTRA_MMS) if (!ordered.includes(code)) ordered.push(code);
  for (const [code] of EXTRA_MMS) {
    const e = byCode.get(code);
    if (!e.tts_supported || !e.nllb_code) problems.push(`${code}: incomplete`);
    e.enabled = true;
  }
  if (problems.length) throw new Error('pool language problems: ' + problems.join('; '));
  for (const e of reg.languages) e.status = computeStatus(e);
  reg.total_languages = reg.languages.length;
  return ordered;
}

export function poolFileContents(ordered) {
  return JSON.stringify({
    note: 'Ordered broadcast set (first 100 = original layout; the last 26 are the second batch). Generated by scripts/add-pool-languages.js — alternates Piper and MMS voices.',
    count: ordered.length, languages: ordered,
  }, null, 2) + '\n';
}

export const POOL_FILE = POOL;

// CLI: patch the committed languages.json in place. (build-registry.js applies
// the same function as its last step, so regenerating keeps the pool set.)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reg = JSON.parse(readFileSync(REG, 'utf8'));
  const ordered = applyPoolLanguages(reg);
  writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n');
  writeFileSync(POOL, poolFileContents(ordered));
  const by = new Map(reg.languages.map((l) => [l.language_code, l]));
  const eng = ordered.reduce((a, c) => ((a[by.get(c).tts_engine] = (a[by.get(c).tts_engine] || 0) + 1), a), {});
  console.log(`pool languages: ${ordered.length} (${JSON.stringify(eng)}) | registry total ${reg.total_languages}`);
}

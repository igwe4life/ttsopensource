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
// cy da de el es et fa fi fr hu is it ka kk lt lv ne nl no pl pt ro ru sk sl
// sr sv sw tr uk vi zh) are untouched.
const PIPER_VOICES = {
  hi: 'hi_IN-pratham-medium', id: 'id_ID-news_tts-medium', th: 'th_TH-tsync2-medium',
  bn: 'bn_BD-google-medium', he: 'he_IL-saspeech-medium', eu: 'eu_ES-antton-medium',
  ml: 'ml_IN-arjun-medium', mr: 'mr_IN-google-medium', te: 'te_IN-maya-medium',
  sq: 'sq_AL-edon-medium', ur: 'ur_PK-fasih-medium', hy: 'hy_AM-gor-medium',
  lb: 'lb_LU-marylux-medium', ko: 'ko_KR-kss-medium', ja: 'ja_JP-hi_fi_captain-medium',
  ku: 'ku_TR-berfin_renas-medium',
};

// ── MMS-TTS checkpoints verified present. code -> 3-letter MMS id.
const MMS_IDS = {
  // existing registry rows: fix id / enable
  mg: 'mlg', mn: 'mon', gu: 'guj', kn: 'kan', lo: 'lao', pa: 'pan', tl: 'tgl',
  az: 'azj-script_latin', ms: 'zlm', ta: 'tam',
  // new rows below
  ceb: 'ceb', ak: 'aka', om: 'orm', ti: 'tir', lg: 'lug', ny: 'nya', bm: 'bam', ki: 'kik',
  ee: 'ewe', ts: 'tso', rn: 'run', sag: 'sag', mos: 'mos', kab: 'kab', fon: 'fon',
  kbp: 'kbp', bem: 'bem', ay: 'ayr', gn: 'grn', qu: 'quy', ky: 'kir',
};

// Existing rows that have a voice but were missing their NLLB-200 code.
const NLLB_FIX = { fo: 'fao_Latn', tt: 'tat_Cyrl' };

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
};

// The 100 broadcast languages, ordered so that taking every Nth entry gives
// each GPU shard an even mix of Piper and MMS voices (MMS is the slower path).
const PIPER_CODES = ('ar bg ca cs cy da de el es et fa fi fr hu is it ka kk lt lv ne nl no pl pt ro ru sk sl sr sv sw tr uk vi zh '
  + Object.keys(PIPER_VOICES).join(' ')).split(' ');
const MMS_CODES = ('am as ff fo ha ht jw km my rw sn so su tg tt tw yo ' + Object.keys(MMS_IDS).join(' ')).split(' ');
// (la, bo excluded on purpose: Latin / Tibetan are not useful broadcast targets;
// ba excluded: Bashkir is not in NLLB-200, so it cannot be translated into.)

function computeStatus(e) {
  if (!e.translation_supported || !e.tts_supported) return 'unsupported';
  if (!e.stt_supported || e.quality_level === 'experimental') return 'experimental';
  if (e.quality_level === 'medium' || e.quality_level === 'limited') return 'limited';
  return 'available';
}

const reg = JSON.parse(readFileSync(REG, 'utf8'));
const byCode = new Map(reg.languages.map((l) => [l.language_code, l]));

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

let added = 0, updated = 0;
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
    added++;
  }
}
for (const [code, nllb] of Object.entries(NLLB_FIX)) {
  Object.assign(byCode.get(code), { nllb_code: nllb, translation_supported: true, translation_model: 'nllb' });
}
for (const [code, voice] of Object.entries(PIPER_VOICES)) { applyPiper(byCode.get(code), voice); updated++; }
for (const [code, id] of Object.entries(MMS_IDS)) { applyMms(byCode.get(code), id); updated++; }

// Already-routed languages keep their route but must be enabled for broadcast.
const ordered = [];
const pi = [...new Set(PIPER_CODES)], mi = [...new Set(MMS_CODES)];
for (let i = 0; i < Math.max(pi.length, mi.length); i++) {
  if (i < pi.length) ordered.push(pi[i]);
  if (i < mi.length) ordered.push(mi[i]);
}
const problems = [];
for (const code of ordered) {
  const e = byCode.get(code);
  if (!e) { problems.push(`${code}: not in registry`); continue; }
  if (!e.tts_supported) problems.push(`${code}: no TTS route`);
  if (!e.nllb_code) problems.push(`${code}: no NLLB code`);
  e.enabled = true;
}
for (const e of reg.languages) e.status = computeStatus(e);
reg.total_languages = reg.languages.length;
if (problems.length) { console.error('PROBLEMS:\n ' + problems.join('\n ')); process.exit(1); }

writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n');
writeFileSync(POOL, JSON.stringify({
  note: 'Ordered broadcast set (100 languages). Generated by scripts/add-pool-languages.js — alternates Piper and MMS voices.',
  count: ordered.length, languages: ordered,
}, null, 2) + '\n');
const eng = ordered.reduce((a, c) => ((a[byCode.get(c).tts_engine] = (a[byCode.get(c).tts_engine] || 0) + 1), a), {});
console.log(`pool languages: ${ordered.length} (${JSON.stringify(eng)}) | rows added ${added}, TTS routes set ${updated} | registry total ${reg.total_languages}`);

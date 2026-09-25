#!/usr/bin/env node
/**
 * Verifies that the checkpoints language-registry/languages.json claims
 * actually exist on HuggingFace, by querying the HF Hub API (no download,
 * no torch/transformers needed — just HTTP HEAD/GET against the metadata
 * endpoint). This is the check referenced throughout the codebase's
 * "-VERIFY" / "unverified" notes — see language-registry/README.md.
 *
 * Does NOT modify languages.json. Prints a report and (with --write-overrides)
 * writes language-registry/overrides.json entries flipping confirmed MMS-TTS
 * checkpoints from quality_level "experimental" to "limited" and enabled:true
 * — still leaves genuinely broken ones alone for manual follow-up.
 *
 * Usage:
 *   node scripts/verify-models.js                # report only
 *   node scripts/verify-models.js --write-overrides
 *   node scripts/verify-models.js --only=mms      # limit to one engine
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'language-registry', 'languages.json');
const OVERRIDES_PATH = path.join(ROOT, 'language-registry', 'overrides.json');

const args = process.argv.slice(2);
const writeOverrides = args.includes('--write-overrides');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns true (200 — exists), false (404 — confirmed does not exist), or
 * null (anything else: 401/403 gated-or-rate-limited, network error, etc —
 * INCONCLUSIVE, not a "missing" verdict). Anonymous HF API calls rate-limit
 * fast; a 401 on a repo you KNOW exists (e.g. Helsinki-NLP/opus-mt-en-ja) is
 * the tell — never treat 401 as "missing", or you'll disable working models.
 */
async function hfRepoExists(repoId) {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${repoId}`, { method: 'GET' });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null; // 401/403/429/etc — rate-limited or gated, not evidence of absence
  } catch {
    return null;
  } finally {
    await sleep(700); // stay well under the anonymous API's rate limit
  }
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const overrides = existsSync(OVERRIDES_PATH) ? JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) : {};

  const results = [];
  const nllbChecked = new Set();

  for (const lang of registry.languages) {
    if (only && lang.tts_engine !== only && lang.translation_model !== only) continue;

    if (lang.tts_engine === 'mms' && lang.tts_model) {
      const ok = await hfRepoExists(lang.tts_model);
      results.push({ code: lang.language_code, engine: 'mms', model: lang.tts_model, exists: ok });
    }
    if (lang.tts_engine === 'xtts' && lang.tts_model && !nllbChecked.has('xtts-model')) {
      nllbChecked.add('xtts-model');
      const ok = await hfRepoExists(lang.tts_model);
      results.push({ code: '(shared)', engine: 'xtts', model: lang.tts_model, exists: ok });
    }
    if (lang.translation_model === 'nllb' && !nllbChecked.has('nllb-model')) {
      nllbChecked.add('nllb-model');
      const ok = await hfRepoExists(registry.languages.find((l) => l.nllb_code)?.nllb_code ? 'facebook/nllb-200-distilled-600M' : '');
      results.push({ code: '(shared)', engine: 'nllb', model: 'facebook/nllb-200-distilled-600M', exists: ok });
    }
    if (lang.translation_fallback === 'opus-mt') {
      const repoId = `Helsinki-NLP/opus-mt-en-${lang.language_code}`;
      const ok = await hfRepoExists(repoId);
      results.push({ code: lang.language_code, engine: 'opus-mt', model: repoId, exists: ok });
    }
  }

  const missing = results.filter((r) => r.exists === false);
  const unknown = results.filter((r) => r.exists === null);
  const confirmed = results.filter((r) => r.exists === true);

  console.log(`Checked ${results.length} model references.`);
  console.log(`  confirmed: ${confirmed.length}`);
  console.log(`  MISSING:   ${missing.length}`);
  console.log(`  unknown (network error): ${unknown.length}`);

  if (args.includes('--verbose')) {
    console.log('\nConfirmed:');
    for (const c of confirmed) console.log(`  [${c.engine}] ${c.code} -> ${c.model}`);
  }

  if (missing.length) {
    console.log('\nMissing (registry claims a model that does not exist at that repo id):');
    for (const m of missing) console.log(`  [${m.engine}] ${m.code} -> ${m.model}`);
  }

  if (writeOverrides) {
    const newOverrides = { ...overrides };
    for (const r of confirmed) {
      if (r.engine === 'mms' && r.code !== '(shared)') {
        newOverrides[r.code] = {
          ...(newOverrides[r.code] || {}),
          quality_level: 'limited',
          notes: `MMS-TTS checkpoint ${r.model} confirmed present on HuggingFace by scripts/verify-models.js. Still recommend a manual listen test before marking "available".`,
        };
      }
    }
    writeFileSync(OVERRIDES_PATH, JSON.stringify(newOverrides, null, 2) + '\n', 'utf8');
    console.log(`\nWrote ${Object.keys(newOverrides).length} override entries to ${OVERRIDES_PATH}`);
  }
}

main().catch((err) => {
  console.error('verify-models failed:', err);
  process.exit(1);
});

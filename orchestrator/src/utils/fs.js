// Reused verbatim from ttsengine/src/utils/fs.js — generic helpers, no
// Azure/proprietary dependency.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Ensure a directory exists (and any parents). Returns the same path. */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Recursive directory removal; ignores missing paths. */
export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** True if a file exists at path. */
export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Write JSON checkpoint; resolves the path written. */
export async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

/** Read a JSON checkpoint; returns null if missing or invalid. */
export async function readJson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Resolve a path relative to the project root (this file is src/utils/fs.js). */
export function projectRoot(...segments) {
  const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
  return path.join(root, ...segments);
}

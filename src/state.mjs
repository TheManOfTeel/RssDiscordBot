/**
 * Per-feed state, persisted as JSON in the repo.
 *
 * Why the repo and not actions/cache: cache entries are evicted after 7 days without a
 * read, are immutable once written (so you'd need rotating keys), and share a 10 GB repo
 * cap. A committed file is durable, diffable, and the commit doubles as repo activity —
 * which is what keeps GitHub from auto-disabling a scheduled workflow after 60 days.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 1;
export const DEFAULT_SEEN_CAP = 500;

/**
 * Convert a feed id into a safe filename.
 * Replaces unsafe characters, collapses dots, and trims edges.
 *
 * @param {string} id - Feed ID
 * @returns {string} Safe filename
 * @throws {Error} If the id produces an empty filename
 */
export function safeStateName(id) {
  const cleaned = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // No ".." components (/ is already stripped)
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!cleaned) throw new Error(`feed id ${JSON.stringify(id)} is not usable as a filename`);
  return cleaned;
}

/**
 * Compute the state file path for a feed.
 *
 * @param {string} stateDir - State directory path
 * @param {string} id - Feed ID
 * @returns {string} Full path to state JSON file
 */
export const statePath = (stateDir, id) => path.join(stateDir, `${safeStateName(id)}.json`);

/**
 * Create an empty state object with all required fields.
 *
 * @returns {object} Empty state
 */
function emptyState() {
  return { version: STATE_VERSION, initialized: false, seen: [], etag: null, lastModified: null, lastRun: null, lastSuccess: null };
}

/**
 * Load a feed's state from disk, or return empty state if missing.
 * Corrupt files are reset instead of causing an error.
 *
 * @param {string} stateDir - State directory
 * @param {string} id - Feed ID
 * @returns {Promise<object>} State object with version, initialized, seen[], etag, etc.
 */
export async function loadState(stateDir, id) {
  try {
    const parsed = JSON.parse(await readFile(statePath(stateDir, id), 'utf8'));
    return {
      ...emptyState(),
      ...parsed,
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((x) => typeof x === 'string') : [],
      initialized: parsed.initialized === true,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    // Corrupt state files are reset (logged via corruptedAt timestamp)
    // Next run will re-seed and skip a batch rather than spam
    if (err instanceof SyntaxError) {
      const reset = emptyState();
      reset.corruptedAt = new Date().toISOString();
      return reset;
    }
    throw err;
  }
}

/**
 * Persist state to disk atomically (write temp, then rename).
 *
 * @param {string} stateDir - State directory
 * @param {string} id - Feed ID
 * @param {object} state - State object to save
 */
export async function saveState(stateDir, id, state) {
  await mkdir(stateDir, { recursive: true });
  const file = statePath(stateDir, id);
  const tmp = `${file}.tmp`;
  // Write-then-rename ensures partial writes can't corrupt state on job kill
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * Merge current feed IDs into the seen list, newest-first, respecting the cap.
 * Never evicts an ID still present in the feed (avoids re-posting on every run).
 *
 * @param {string[]} currentIds - IDs from this fetch
 * @param {string[]} previousSeen - Previously seen IDs
 * @param {number} cap - Maximum list size (default DEFAULT_SEEN_CAP)
 * @returns {string[]} Merged and deduplicated ID list
 */
export function mergeSeen(currentIds, previousSeen, cap = DEFAULT_SEEN_CAP) {
  const effectiveCap = Math.max(cap, currentIds.length);
  const merged = [];
  const seen = new Set();
  for (const id of [...currentIds, ...previousSeen]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
    if (merged.length >= effectiveCap) break;
  }
  return merged;
}

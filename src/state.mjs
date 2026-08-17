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

/** Feed ids become filenames, so constrain them hard. */
export function safeStateName(id) {
  const cleaned = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.') // no ".." components, even though "/" is already gone
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!cleaned) throw new Error(`feed id ${JSON.stringify(id)} is not usable as a filename`);
  return cleaned;
}

export const statePath = (stateDir, id) => path.join(stateDir, `${safeStateName(id)}.json`);

function emptyState() {
  return { version: STATE_VERSION, initialized: false, seen: [], etag: null, lastModified: null, lastRun: null, lastSuccess: null };
}

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
    // A corrupt state file must not wedge the feed forever. Reset, but say so loudly:
    // the next run will re-seed and skip a batch rather than spam the channel.
    if (err instanceof SyntaxError) {
      const reset = emptyState();
      reset.corruptedAt = new Date().toISOString();
      return reset;
    }
    throw err;
  }
}

export async function saveState(stateDir, id, state) {
  await mkdir(stateDir, { recursive: true });
  const file = statePath(stateDir, id);
  const tmp = `${file}.tmp`;
  // Write-then-rename: a killed run (Actions timeout, cancellation) can't leave a half file.
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * Merge this fetch's ids into the seen list, newest-first, capped.
 *
 * The cap never evicts an id that is still present in the feed — otherwise a feed with
 * more items than the cap would re-post its tail on every run, forever.
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

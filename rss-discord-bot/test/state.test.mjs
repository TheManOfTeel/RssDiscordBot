import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadState, mergeSeen, safeStateName, saveState, STATE_VERSION } from '../src/state.mjs';

const scratch = () => mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'rss-state-'));

test('feed ids are sanitised into safe filenames', () => {
  assert.equal(safeStateName('HN Frontpage'), 'hn-frontpage');
  assert.equal(safeStateName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeStateName('a/b'), 'a-b');
  assert.equal(safeStateName('feed.v2'), 'feed.v2', 'single dots are fine');
  // Anything traversal-shaped either throws or comes back with no ".." and no separator.
  for (const hostile of ['///', '..', '.', '-', '..%2f..', '../x', '..\\..\\x', 'a/../../b']) {
    let name;
    try {
      name = safeStateName(hostile);
    } catch {
      continue;
    }
    assert.equal(/\.\.|[/\\]/.test(name), false, `${hostile} sanitised to an unsafe name: ${name}`);
  }
  assert.throws(() => safeStateName('///'), /not usable as a filename/);
  assert.throws(() => safeStateName('..'), /not usable as a filename/);
});

test('missing state loads as an uninitialised default', async () => {
  const dir = await scratch();
  const state = await loadState(dir, 'nope');
  assert.deepEqual(state, { version: STATE_VERSION, initialized: false, seen: [], etag: null, lastModified: null, lastRun: null, lastSuccess: null });
});

test('state round-trips through disk', async () => {
  const dir = await scratch();
  await saveState(dir, 'feed-1', { version: 1, initialized: true, seen: ['a', 'b'], etag: 'W/"x"', lastModified: null, lastRun: '2026-08-17T00:00:00.000Z' });
  const state = await loadState(dir, 'feed-1');
  assert.equal(state.initialized, true);
  assert.deepEqual(state.seen, ['a', 'b']);
  assert.equal(state.etag, 'W/"x"');
  const raw = await readFile(path.join(dir, 'feed-1.json'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'trailing newline keeps git diffs clean');
});

test('a corrupt state file resets instead of wedging the feed forever', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8');
  const state = await loadState(dir, 'broken');
  assert.equal(state.initialized, false);
  assert.ok(state.corruptedAt, 'reset is recorded so the run can report it');
});

test('non-string junk in seen is discarded', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'junk.json'), JSON.stringify({ seen: ['ok', 5, null, { a: 1 }], initialized: true }), 'utf8');
  assert.deepEqual((await loadState(dir, 'junk')).seen, ['ok']);
});

test('mergeSeen puts current ids first and dedupes', () => {
  assert.deepEqual(mergeSeen(['c', 'b'], ['b', 'a']), ['c', 'b', 'a']);
});

test('mergeSeen honours the cap', () => {
  const merged = mergeSeen(['x'], ['a', 'b', 'c', 'd'], 3);
  assert.deepEqual(merged, ['x', 'a', 'b']);
});

test('the cap never evicts an id still present in the feed', () => {
  // A 40-item feed with a cap of 10 must not forget items 11..40, or it re-posts them
  // on every single run.
  const current = Array.from({ length: 40 }, (_, i) => `id-${i}`);
  const merged = mergeSeen(current, ['old'], 10);
  assert.equal(merged.length, 40);
  for (const id of current) assert.ok(merged.includes(id));
  assert.equal(merged.includes('old'), false, 'older history is what gets dropped');
});

test('mergeSeen drops falsy ids', () => {
  assert.deepEqual(mergeSeen(['a', '', null], [undefined, 'b']), ['a', 'b']);
});

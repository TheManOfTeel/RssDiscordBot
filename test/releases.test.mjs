/**
 * The public/pre-release split is two feed entries reading one URL, so the two filter
 * blocks must PARTITION the feed: every item lands in exactly one channel stream. A gap
 * silently drops a release; an overlap double-posts it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { evaluate } from '../src/filter.mjs';

const NOW = Date.parse('2026-08-17T12:00:00Z');

const config = await loadConfig(path.join(import.meta.dirname, '..', 'feeds.json'));
const stream = (id) => config.feeds.find((f) => f.id === id);

/** Mirrors runFeed: every block in the chain must pass. */
const passes = (feed, item) => feed.filterChain.every((filters) => evaluate(item, filters, NOW).pass);

const item = (title) => ({
  id: title,
  title,
  summary: '',
  content: '',
  categories: [],
  author: undefined,
  link: 'https://developer.apple.com/news/releases/',
  isoDate: new Date(NOW).toISOString(),
});

// Titles shaped like Apple's releases feed. NOT captured from the live feed — the sandbox
// has no network — so treat the exact wording as an assumption, not a verified fixture.
const PUBLIC = [
  'iOS 26.1 (23B74)',
  'iPadOS 26.1 (23B74)',
  'macOS 26.1 (25B74)',
  'watchOS 26.1 (23R5000)',
  'tvOS 26.1 (23J5000)',
  'visionOS 26.1 (23N5000)',
  'AirPods Pro (2nd generation) Firmware 8.1.1',
];

const PRERELEASE = [
  'iOS 26.2 beta (23C5030d)',
  'iOS 26.2 beta 3 (23C5044f)',
  'macOS 26.2 beta 2 (25C5033e)',
  'watchOS 26.2 RC (23S5040c)',
  'iOS 26.2 Public Beta',
  'AirPods Pro 26.2 beta (23C5030d)',
];

test('every public release reaches the public stream only', () => {
  for (const title of PUBLIC) {
    assert.equal(passes(stream('apple-releases'), item(title)), true, `public stream should take: ${title}`);
    assert.equal(passes(stream('apple-releases-beta'), item(title)), false, `beta stream should reject: ${title}`);
  }
});

test('every pre-release reaches the beta stream only', () => {
  for (const title of PRERELEASE) {
    assert.equal(passes(stream('apple-releases-beta'), item(title)), true, `beta stream should take: ${title}`);
    assert.equal(passes(stream('apple-releases'), item(title)), false, `public stream should reject: ${title}`);
  }
});

test('the two blocks are exact complements, so nothing is dropped or doubled', () => {
  for (const title of [...PUBLIC, ...PRERELEASE]) {
    const hits = ['apple-releases', 'apple-releases-beta'].filter((id) => passes(stream(id), item(title)));
    assert.equal(hits.length, 1, `${title} landed in ${hits.length} stream(s): ${hits.join(', ') || 'none'}`);
  }
});

test('"beta" in the body cannot misroute a public release', () => {
  // A public release note routinely says "since beta 4". Matching on `title` only is what
  // keeps that out of the beta stream.
  const release = { ...item('iOS 26.1 (23B74)'), summary: 'This release includes changes since iOS 26.1 beta 4.' };
  assert.equal(passes(stream('apple-releases'), release), true);
  assert.equal(passes(stream('apple-releases-beta'), release), false);
});

test('the split is case-insensitive', () => {
  for (const title of ['iOS 26.2 BETA 3 (23C5044f)', 'iOS 26.2 Beta 3 (23C5044f)']) {
    assert.equal(passes(stream('apple-releases-beta'), item(title)), true, title);
    assert.equal(passes(stream('apple-releases'), item(title)), false, title);
  }
});

test('dev news is unfiltered — it is a single-stream feed', () => {
  const news = stream('apple-dev-news');
  assert.equal(news.webhookEnv, 'DISCORD_WEBHOOK_APPLE_DEV_NEWS');
  assert.equal(
    passes(news, item('Get ready for the next generation of App Store Connect')),
    true,
    'no include list means everything passes'
  );
});

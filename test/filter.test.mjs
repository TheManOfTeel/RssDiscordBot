import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { compileFilters, evaluate, FilterConfigError, haystack } from '../src/filter.mjs';

const item = (over = {}) => ({
  id: 'x',
  title: 'Announcing TypeScript 6',
  summary: 'Big release with decorators.',
  content: '<p>Big release</p>',
  author: 'Danny',
  categories: ['typescript', 'releases'],
  link: 'https://example.com/x',
  isoDate: new Date('2026-08-17T00:00:00Z').toISOString(),
  ...over,
});

const NOW = Date.parse('2026-08-17T12:00:00Z');

test('include is OR by default, case-insensitive', () => {
  const f = compileFilters({ include: ['\\bgo\\b', '\\btypescript\\b'] });
  assert.equal(evaluate(item(), f, NOW).pass, true);
  assert.equal(evaluate(item({ title: 'Announcing Rust 2.0', summary: 'x', categories: [] }), f, NOW).pass, false);
});

test('requireAll turns include into AND', () => {
  const f = compileFilters({ include: ['typescript', 'decorators'], fields: ['title', 'summary'], requireAll: true });
  assert.equal(evaluate(item(), f, NOW).pass, true);
  assert.equal(evaluate(item({ summary: 'no mention' }), f, NOW).pass, false);
});

test('exclude beats include', () => {
  const f = compileFilters({ include: ['typescript'], exclude: ['decorators'], fields: ['title', 'summary'] });
  const verdict = evaluate(item(), f, NOW);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /excluded/);
});

test('no include list means everything passes', () => {
  assert.equal(evaluate(item(), compileFilters({}), NOW).pass, true);
});

test('fields scope the search', () => {
  const titleOnly = compileFilters({ include: ['decorators'], fields: ['title'] });
  assert.equal(evaluate(item(), titleOnly, NOW).pass, false);
  const withSummary = compileFilters({ include: ['decorators'], fields: ['title', 'summary'] });
  assert.equal(evaluate(item(), withSummary, NOW).pass, true);
});

test('categories arrays are searchable', () => {
  const f = compileFilters({ include: ['^releases$'], fields: ['categories'] });
  assert.equal(evaluate(item(), f, NOW).pass, true);
});

test('maxAgeHours drops stale items, and undated items when set', () => {
  const f = compileFilters({ maxAgeHours: 6 });
  assert.equal(evaluate(item(), f, NOW).pass, false, '36h old');
  assert.equal(evaluate(item({ isoDate: new Date(NOW - 3600_000).toISOString() }), f, NOW).pass, true);
  assert.match(evaluate(item({ isoDate: undefined }), f, NOW).reason, /no date/);
});

test('items without a link are dropped unless requireLink is false', () => {
  assert.match(evaluate(item({ link: '' }), compileFilters({}), NOW).reason, /no link/);
  assert.equal(evaluate(item({ link: '' }), compileFilters({ requireLink: false }), NOW).pass, true);
});

test('global regex flags do not leak lastIndex between items', () => {
  const f = compileFilters({ include: ['typescript'], flags: 'gi', fields: ['title'] });
  assert.equal(evaluate(item(), f, NOW).pass, true);
  assert.equal(evaluate(item(), f, NOW).pass, true, 'second call must not fail from a stale lastIndex');
});

test('config errors are raised at compile time, not at match time', () => {
  assert.throws(() => compileFilters({ include: ['(unclosed'] }), FilterConfigError);
  assert.throws(() => compileFilters({ include: [42] }), FilterConfigError);
  assert.throws(() => compileFilters({ fields: ['nope'] }), FilterConfigError);
  assert.throws(() => compileFilters({ fields: [] }), FilterConfigError);
  assert.throws(() => compileFilters({ flags: 'q' }), FilterConfigError);
  assert.throws(() => compileFilters({ maxAgeHours: -1 }), FilterConfigError);
});

test('haystack joins arrays one-per-line and skips absent fields', () => {
  assert.equal(haystack({ title: 'a', categories: ['b', 'c'] }, ['title', 'categories', 'author']), 'a\nb\nc');
});

test('anchors match a whole category, not the joined blob', () => {
  const f = compileFilters({ include: ['^release$'], fields: ['categories'] });
  assert.equal(evaluate(item({ categories: ['typescript', 'release'] }), f, NOW).pass, true);
  assert.equal(evaluate(item({ categories: ['release candidate'] }), f, NOW).pass, false);
});

test('explicit flags override the im default', () => {
  const caseSensitive = compileFilters({ include: ['TypeScript'], fields: ['title'], flags: '' });
  assert.equal(evaluate(item(), caseSensitive, NOW).pass, true);
  assert.equal(evaluate(item({ title: 'announcing typescript 6' }), caseSensitive, NOW).pass, false);
});

test('CBS NFL and CFB feeds block sports betting language', () => {
  const feeds = JSON.parse(fs.readFileSync(new URL('../feeds.json', import.meta.url), 'utf8')).feeds;
  const nfl = feeds.find((feed) => feed.id === 'nfl-news');
  const cfb = feeds.find((feed) => feed.id === 'cfb-news');
  const patterns = [nfl.filters.exclude.join('\n'), cfb.filters.exclude.join('\n')].join('\n');

  assert.match(patterns, /best bets|player props|odds|sportsbook/i);
  assert.match(patterns, /betting/i);
});

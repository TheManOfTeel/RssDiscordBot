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

test('CBS NFL and NCAAF feeds block sports betting language', () => {
  const feeds = JSON.parse(fs.readFileSync(new URL('../feeds.json', import.meta.url), 'utf8')).feeds;
  const nfl = feeds.find((feed) => feed.id === 'nfl-news');
  const cfb = feeds.find((feed) => feed.id === 'ncaaf-news');
  const patterns = [nfl.filters.exclude.join('\n'), cfb.filters.exclude.join('\n')].join('\n');

  assert.match(patterns, /best bets|player props|odds|sportsbook/i);
  assert.match(patterns, /betting/i);
});

test('OpenAI and Claude status feeds keep model incidents and drop payment issues', () => {
  const feeds = JSON.parse(fs.readFileSync(new URL('../feeds.json', import.meta.url), 'utf8')).feeds;
  const openai = compileFilters(feeds.find((feed) => feed.id === 'openai-status').filters);
  const claude = compileFilters(feeds.find((feed) => feed.id === 'claude-status').filters);
  const passes = (filters, title, summary = '') => evaluate(item({ title, summary }), filters, NOW).pass;

  assert.equal(passes(openai, 'Elevated errors for GPT-5.2'), true);
  assert.equal(passes(openai, 'Elevated Errors On API', 'Affected components: Chat Completions (Degraded performance)'), true);
  assert.equal(passes(openai, 'Elevated ChatGPT Conversation Errors'), true);
  assert.equal(passes(openai, 'Unable to start new Workspace Agent runs'), true);
  assert.equal(passes(openai, 'Elevated error rates for hosted Code Reviews'), true);
  assert.equal(passes(
    openai,
    'Delayed Costs Data in the Compliance API',
    'We have identified an issue causing delays in publishing Organization cost data through the Costs API. API and ChatGPT usage are not affected. We are working to restore normal data freshness. Affected components: Compliance API (Degraded performance)'
  ), false);
  assert.equal(passes(openai, 'Elevated errors with ChatGPT billing and Ads billing'), false);
  assert.equal(passes(openai, 'Elevated errors for some U.S. business Mastercards'), false);
  assert.equal(passes(openai, 'Elevated errors affecting the Microsoft 365 connector'), false);

  assert.equal(passes(claude, 'Elevated errors for Claude Opus 4.1'), true);
  assert.equal(passes(claude, 'Elevated errors on claude.ai and the Claude API'), true);
  assert.equal(passes(claude, 'Elevated errors on claude.ai, Claude Code, and platform.claude.com'), true);
  assert.equal(passes(claude, 'Elevated purchasing errors on claude.ai'), false);
  assert.equal(passes(claude, 'Elevated errors affecting the Google Calendar connector on claude.ai, Claude Code, and Claude Cowork'), false);
  assert.equal(passes(claude, 'Some users unable to sign up with Apple on the Claude iOS app'), false);
});

test('cloud status feeds keep developer-service disruptions and drop unrelated incidents', () => {
  const feeds = JSON.parse(fs.readFileSync(new URL('../feeds.json', import.meta.url), 'utf8')).feeds;
  const filtersFor = (id) => compileFilters(feeds.find((feed) => feed.id === id).filters);
  const passes = (filters, title, summary = '') => evaluate(item({ title, summary }), filters, NOW).pass;
  const aws = filtersFor('aws-status');
  const azure = filtersFor('azure-status');
  const cloudflare = filtersFor('cloudflare-status');
  const google = filtersFor('google-cloud-status');

  assert.equal(passes(aws, 'Lambda elevated error rates'), true);
  assert.equal(passes(aws, 'Service disruption: Increased Error Rates', 'Unable to reliably support customer applications in the region.'), true);
  assert.equal(passes(aws, 'AWS Marketplace billing delays'), false);

  assert.equal(passes(azure, 'Elevated errors in Azure Functions'), true);
  assert.equal(passes(azure, 'Azure DevOps pipelines unavailable'), true);
  assert.equal(passes(azure, 'Microsoft 365 sign-in issues'), false);

  assert.equal(passes(cloudflare, 'Elevated error rate for Workers startup'), false);
  assert.equal(passes(cloudflare, 'Cloudflare is seeing an issue with Workers API availability'), true);
  assert.equal(passes(cloudflare, 'Workers API is unavailable'), true);
  assert.equal(passes(cloudflare, 'Increased errors for R2 and Tiered Cache', 'A small percentage of requests failed.'), false);
  assert.equal(passes(cloudflare, 'Elevated error rate for workers startup'), false);
  assert.equal(passes(cloudflare, 'Issues with 1.1.1.1 public resolver in Canada'), false);

  assert.equal(passes(google, 'Cloud Run elevated error rates'), true);
  assert.equal(passes(google, 'RESOLVED: Multiple services were experiencing issues in the europe-west2 region'), true);
  assert.equal(passes(google, 'Delayed billing export data'), false);
});

/**
 * End-to-end: real config loading, real parsing, real filtering, real state files.
 * Only the network is stubbed (globalThis.fetch), which is what the modules resolve at
 * call time via their `fetchImpl = fetch` defaults.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { compileFilters } from '../src/filter.mjs';
import { groupForDelivery, main, mentionsFor, parseArgs } from '../src/runner.mjs';
import { loadState } from '../src/state.mjs';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/test-token';
const FEED_URL = 'https://example.com/feed.xml';
const OTHER_URL = 'https://example.com/other.xml';

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.link}</guid><pubDate>${i.date}</pubDate><description>${i.desc ?? ''}</description></item>`).join('\n')}
</channel></rss>`;

let realFetch;
let realLog;
let posted;
let routes;
let dir;

function stubFetch() {
  posted = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith('https://discord.com/')) {
      posted.push(...JSON.parse(init.body).embeds);
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: '1' }), text: async () => '{}' };
    }
    const route = routes[href.split('?')[0]];
    if (!route) throw new Error(`unexpected fetch: ${href}`);
    if (typeof route === 'function') return route(init);
    return { ok: true, status: 200, headers: new Headers(route.headers ?? {}), text: async () => route.body };
  };
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  realLog = console.log;
  console.log = () => {};
  dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'rss-run-'));
  process.env.DISCORD_WEBHOOK = WEBHOOK;
  routes = {};
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  delete process.env.DISCORD_WEBHOOK;
});

async function writeConfig(config) {
  const file = path.join(dir, 'feeds.json');
  await writeFile(file, JSON.stringify(config), 'utf8');
  return file;
}

const run = (file, extra = []) => main(['--config', file, '--state-dir', path.join(dir, 'state'), ...extra]);

const ITEM_A = { title: 'Alpha about TypeScript', link: 'https://example.com/a', date: 'Mon, 03 Aug 2026 10:00:00 GMT' };
const ITEM_B = { title: 'Beta about TypeScript', link: 'https://example.com/b', date: 'Tue, 04 Aug 2026 10:00:00 GMT' };
const ITEM_C = { title: 'Gamma about crypto', link: 'https://example.com/c', date: 'Wed, 05 Aug 2026 10:00:00 GMT' };

test('first run seeds state and posts nothing', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL }] });
  routes[FEED_URL] = { body: rss([ITEM_A, ITEM_B]) };

  assert.equal(await run(file), 0);
  assert.equal(posted.length, 0, 'a cold start must not dump the whole feed');

  const state = await loadState(path.join(dir, 'state'), 'f');
  assert.equal(state.initialized, true);
  assert.equal(state.seen.length, 2);
});

test('the second run posts only what is new, oldest first', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL, filters: { include: ['typescript'] } }] });
  routes[FEED_URL] = { body: rss([ITEM_B]) };
  await run(file);

  // Newest-first feed order, but delivery must be chronological.
  routes[FEED_URL] = { body: rss([ITEM_C, ITEM_A, ITEM_B]) };
  assert.equal(await run(file), 0);

  assert.deepEqual(posted.map((e) => e.title), ['Alpha about TypeScript'], 'crypto item excluded by the include filter');
  assert.equal(posted[0].url, 'https://example.com/a');
  assert.equal(posted[0].timestamp, '2026-08-03T10:00:00.000Z');
  assert.equal(posted[0].footer.text, 'f');

  // Everything the feed contained is now seen, including the filtered-out item, so it is
  // never reconsidered.
  const state = await loadState(path.join(dir, 'state'), 'f');
  assert.equal(state.seen.length, 3);

  await run(file);
  assert.equal(posted.length, 1, 'a third run with no changes posts nothing');
});

test('feed-level description toggle suppresses the body text while keeping the title link', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL, showDescription: false, filters: { include: ['typescript'] } }] });
  routes[FEED_URL] = { body: rss([{ ...ITEM_A, desc: 'A longer body that should be hidden' }]) };

  assert.equal(await run(file), 0, 'first run seeds state and posts nothing');

  routes[FEED_URL] = { body: rss([{ ...ITEM_B, desc: 'A longer body that should be hidden' }]) };
  assert.equal(await run(file), 0, 'second run posts the change set');

  assert.equal(posted.length, 1, 'only the new item is posted');
  assert.equal(posted[0].title, 'Beta about TypeScript');
  assert.equal(posted[0].url, 'https://example.com/b');
  assert.equal(posted[0].description, undefined, 'body text disabled via config should not ship in the embed');
});

test('304 Not Modified short-circuits the run', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL }] });
  routes[FEED_URL] = { body: rss([ITEM_A]), headers: { etag: 'W/"v1"' } };
  await run(file);
  assert.equal((await loadState(path.join(dir, 'state'), 'f')).etag, 'W/"v1"');

  let sentIfNoneMatch;
  routes[FEED_URL] = (init) => {
    sentIfNoneMatch = init.headers['if-none-match'];
    return { ok: false, status: 304, headers: new Headers(), text: async () => '' };
  };
  assert.equal(await run(file), 0);
  assert.equal(sentIfNoneMatch, 'W/"v1"');
  assert.equal(posted.length, 0);

  // A 304 must not clear `seen` — that would re-post the entire feed on the next 200.
  const state = await loadState(path.join(dir, 'state'), 'f');
  assert.deepEqual(state.seen, ['https://example.com/a']);
  assert.equal(state.etag, 'W/"v1"');
});

test('maxPerRun caps a backlog, marks the remainder seen, and reports it', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL, maxPerRun: 2, filters: { requireLink: false } }] });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  await run(file);

  const many = Array.from({ length: 6 }, (_, i) => ({
    title: `New ${i}`,
    link: `https://example.com/n${i}`,
    date: `Mon, 1${i} Aug 2026 10:00:00 GMT`,
  }));
  routes[FEED_URL] = { body: rss(many) };
  assert.equal(await run(file), 0);

  assert.deepEqual(posted.map((e) => e.title), ['New 4', 'New 5'], 'newest two win');
  const state = await loadState(path.join(dir, 'state'), 'f');
  assert.equal(state.seen.length, 7, 'the skipped four are seen, not queued forever');

  await run(file);
  assert.equal(posted.length, 2, 'skipped items are not resurrected next run');
});

test('one failing feed does not stop the others, and exits 1', async () => {
  const file = await writeConfig({
    feeds: [
      { id: 'broken', url: OTHER_URL },
      { id: 'good', url: FEED_URL },
    ],
  });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  routes[OTHER_URL] = () => ({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: async () => '' });

  assert.equal(await run(file, ['--seed']), 1, 'exit code reflects the failure');

  const good = await loadState(path.join(dir, 'state'), 'good');
  assert.equal(good.initialized, true, 'the healthy feed still persisted its cursor');
  const broken = await loadState(path.join(dir, 'state'), 'broken');
  assert.equal(broken.initialized, false);
});

test('a post failure leaves unposted items to retry next run', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL }] });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  await run(file);

  routes[FEED_URL] = { body: rss([ITEM_B, ITEM_A]) };
  const workingFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith('https://discord.com/')
      ? { ok: false, status: 400, headers: new Headers(), text: async () => 'bad embed', json: async () => ({}) }
      : workingFetch(url, init);

  assert.equal(await run(file), 1);
  const state = await loadState(path.join(dir, 'state'), 'f');
  assert.equal(state.seen.includes('https://example.com/b'), false, 'the failed item is not marked seen');

  globalThis.fetch = workingFetch;
  assert.equal(await run(file), 0);
  assert.deepEqual(posted.map((e) => e.title), ['Beta about TypeScript'], 'retried on the next run');
});

test('dry run posts nothing and writes no state', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL }] });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  assert.equal(await run(file, ['--dry-run']), 0);
  assert.equal(posted.length, 0);
  await assert.rejects(() => readFile(path.join(dir, 'state', 'f.json'), 'utf8'), /ENOENT/);
});

test('dry run needs no webhook secret', async () => {
  delete process.env.DISCORD_WEBHOOK;
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL }] });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  assert.equal(await run(file, ['--dry-run', '--verbose']), 0);
});

test('a missing webhook secret fails the feed rather than posting nowhere', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL, webhookEnv: 'ABSENT_HOOK' }] });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  await run(file);
  routes[FEED_URL] = { body: rss([ITEM_A, ITEM_B]) };
  assert.equal(await run(file), 1);
});

test('--only restricts the run', async () => {
  const file = await writeConfig({ feeds: [{ id: 'f', url: FEED_URL }, { id: 'g', url: OTHER_URL }] });
  routes[FEED_URL] = { body: rss([ITEM_A]) };
  assert.equal(await run(file, ['--only', 'f']), 0);
  assert.equal(await run(file, ['--only', 'nope']), 2);
});

test('parseArgs handles flags, values and --flag=value', () => {
  assert.deepEqual(parseArgs(['--config', 'x.json', '-n', '--only', 'a,b', '-v']), {
    config: 'x.json', stateDir: 'state', only: ['a', 'b'], dryRun: true, seed: false, force: false, verbose: true, help: false,
  });
  assert.equal(parseArgs(['--config=y.json']).config, 'y.json');
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['--config']), /requires a value/);
});

test('an unknown argument exits 2 instead of running', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.equal(await main(['--bogus']), 2);
  } finally {
    console.error = realError;
  }
  assert.match(errors.join('\n'), /unknown argument/);
});

/** Atom, with the image attached the way Apple's newsroom feed does it. */
const atom = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
${entries.map((e) => `<entry><title>${e.title}</title><link href="${e.link}"/><id>${e.link}</id><updated>${e.date}</updated><content>${e.content ?? ''}</content><link href="${e.image}" rel="enclosure" type="image/jpeg"/></entry>`).join('\n')}
</feed>`;

const ENTRY_HW = { title: 'Testcorp introduces the testdevice', link: 'https://example.com/hw', date: '2026-08-04T10:00:00Z', image: 'https://example.com/hw.jpg' };
const ENTRY_SW = { title: 'Testcorp updates its terms', link: 'https://example.com/sw', date: '2026-08-05T10:00:00Z', image: 'https://example.com/sw.jpg' };

test('showImage "notified" attaches an image only to items that ping', async () => {
  const config = {
    feeds: [{
      id: 'f',
      url: FEED_URL,
      showImage: 'notified',
      notify: [{ roles: ['123456789012345678'], text: 'New hardware:', when: { fields: ['title'], include: ['testdevice'] } }],
    }],
  };
  const file = await writeConfig(config);
  routes[FEED_URL] = { body: atom([{ ...ENTRY_HW, title: 'seed only', link: 'https://example.com/seed' }]) };
  assert.equal(await run(file), 0, 'first run seeds');

  routes[FEED_URL] = { body: atom([ENTRY_HW, ENTRY_SW]) };
  assert.equal(await run(file), 0);

  assert.equal(posted.length, 2);
  const hw = posted.find((e) => e.title.includes('testdevice'));
  const sw = posted.find((e) => e.title.includes('terms'));
  assert.deepEqual(hw.image, { url: 'https://example.com/hw.jpg' }, 'the pinging item carries its image');
  assert.equal(sw.image, undefined, 'a silent item must not, even though the feed supplied one');
});

test('showImage true attaches images to every item, false to none', async () => {
  for (const [showImage, expected] of [[true, 2], [false, 0]]) {
    posted.length = 0;
    const file = path.join(dir, `feeds-${String(showImage)}.json`);
    await writeFile(file, JSON.stringify({ feeds: [{ id: `f-${showImage}`, url: FEED_URL, showImage }] }), 'utf8');
    routes[FEED_URL] = { body: atom([{ ...ENTRY_HW, title: 'seed', link: 'https://example.com/seed' }]) };
    await main(['--config', file, '--state-dir', path.join(dir, 'state'), ...[]]);
    routes[FEED_URL] = { body: atom([ENTRY_HW, ENTRY_SW]) };
    await main(['--config', file, '--state-dir', path.join(dir, 'state')]);
    assert.equal(posted.filter((e) => e.image).length, expected, `showImage: ${showImage}`);
  }
});

test('mentionsFor unions matching rules and batching overrides are respected', () => {
  const now = Date.now();
  const item = { title: 'iOS release is live', summary: 'major update', link: 'https://example.com/ios' };
  const notify = [
    { roles: ['1'.repeat(18)], users: ['2'.repeat(18)], text: 'Team A', batching: false, when: compileFilters({ fields: ['title'], include: ['iOS'] }) },
    { roles: ['2'.repeat(18)], text: 'Team B', summarize: false, when: compileFilters({ fields: ['summary'], include: ['major'] }) },
    { roles: ['3'.repeat(18)], text: 'Team C', when: compileFilters({ fields: ['title'], include: ['live'] }) },
  ];

  const mention = mentionsFor(item, notify, now);
  assert.equal(mention.batching, false);
  assert.equal(mention.summarize, false);
  assert.deepEqual([...mention.roles].sort(), ['1'.repeat(18), '2'.repeat(18), '3'.repeat(18)].sort());
  assert.deepEqual([...mention.users].sort(), ['2'.repeat(18)].sort());
  assert.equal(mention.text, 'Team A');

  const nextItem = { title: 'other update', summary: 'extra', link: 'https://example.com/other' };
  const groups = groupForDelivery([item, nextItem], notify, now);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items[0].link, 'https://example.com/ios');
  assert.equal(groups[1].items[0].link, 'https://example.com/other');
});

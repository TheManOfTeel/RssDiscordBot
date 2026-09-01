import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadConfig, parseColor, validateConfig } from '../src/config.mjs';

const base = (feeds, defaults) => ({ defaults, feeds });
const oneFeed = (over = {}) => base([{ id: 'a', url: 'https://example.com/feed', ...over }]);

// Deliberately structural, not a snapshot of the current feed list: adding a feed should
// need a feeds.json edit and nothing else. Assert the invariants, never the inventory.
test('the committed feeds.json loads and every feed is usable', async () => {
  const config = await loadConfig(path.join(import.meta.dirname, '..', 'feeds.json'));
  assert.ok(config.feeds.length > 0, 'at least one enabled feed');
  for (const feed of config.feeds) {
    assert.match(feed.url, /^https?:\/\//, `${feed.id}: url`);
    assert.match(feed.webhookEnv, /^[A-Za-z_][A-Za-z0-9_]*$/, `${feed.id}: webhookEnv`);
    assert.ok(feed.maxPerRun >= 1, `${feed.id}: maxPerRun`);
  }
});

test('enabled:false keeps a feed out of the run', () => {
  const { feeds } = validateConfig(
    base([{ id: 'on', url: 'https://e.com/a' }, { id: 'off', url: 'https://e.com/b', enabled: false }])
  );
  assert.deepEqual(feeds.map((f) => f.id), ['on']);
});

test('the two release streams share a URL but nothing else', async () => {
  const config = await loadConfig(path.join(import.meta.dirname, '..', 'feeds.json'));
  const pub = config.feeds.find((f) => f.id === 'apple-releases');
  const beta = config.feeds.find((f) => f.id === 'apple-releases-beta');
  assert.equal(pub.url, beta.url, 'one upstream feed, read twice');
  assert.equal(pub.webhookEnv, 'DISCORD_WEBHOOK_APPLE_RELEASES');
  assert.equal(beta.webhookEnv, 'DISCORD_WEBHOOK_APPLE_RELEASES_BETA', 'betas go to their own channel');
  assert.notEqual(pub.id, beta.id, 'separate state files, so separate dedupe');
});

test('placeholder ping ids warn but do not fail the load', () => {
  const { warnings } = validateConfig(oneFeed({ notify: [{ roles: ['000000000000000000'] }] }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /placeholder id/);
  assert.match(warnings[0], /will not ping anyone/);

  assert.deepEqual(validateConfig(oneFeed({ notify: [{ roles: ['1'.repeat(18)] }] })).warnings, [], 'a real id is silent');
});

test('defaults flow into feeds and feeds win', () => {
  const { feeds } = validateConfig(base([{ id: 'a', url: 'https://e.com/f' }, { id: 'b', url: 'https://e.com/g', maxPerRun: 2 }], { maxPerRun: 9 }));
  assert.equal(feeds[0].maxPerRun, 9);
  assert.equal(feeds[1].maxPerRun, 2);
});

test('a defaults filter block applies on top of each feed block', () => {
  const { feeds } = validateConfig(
    base([{ id: 'a', url: 'https://e.com/f', filters: { include: ['x'] } }], { filters: { exclude: ['spam'] } })
  );
  assert.equal(feeds[0].filterChain.length, 2, 'global block + feed block, both must pass');
  assert.equal(feeds[0].filterChain[0].exclude.length, 1);
  assert.equal(feeds[0].filterChain[1].include.length, 1);
});

test('colours accept hex with or without # and integers', () => {
  assert.equal(validateConfig(oneFeed({ color: '#5865F2' })).feeds[0].color, 0x5865f2);
  assert.equal(validateConfig(oneFeed({ color: '5865f2' })).feeds[0].color, 0x5865f2);
  assert.equal(validateConfig(oneFeed({ color: 123 })).feeds[0].color, 123);
  const errors = [];
  assert.equal(parseColor('#ggg', errors, 'x'), undefined);
  assert.equal(errors.length, 1);
});

test('every problem is reported in one throw, not one at a time', () => {
  try {
    validateConfig(base([{ url: 'ftp://nope' }, { id: 'a', url: 'https://e.com/f', filters: { include: ['('] } }]));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /feeds\[0\]\.id/);
    assert.match(err.message, /feeds\[0\]\.url/);
    assert.match(err.message, /invalid regex/);
  }
});

test('duplicate ids are rejected because ids key the state files', () => {
  assert.throws(
    () => validateConfig(base([{ id: 'dup', url: 'https://e.com/a' }, { id: 'dup', url: 'https://e.com/b' }])),
    /duplicate id/
  );
});

test('ids that collide after filename sanitising are rejected', () => {
  assert.throws(
    () => validateConfig(base([{ id: 'a/b', url: 'https://e.com/a' }, { id: 'a b', url: 'https://e.com/b' }])),
    /both map to the state file a-b\.json/
  );
});

test('an inline webhook URL in the config is a hard error', () => {
  assert.throws(() => validateConfig(oneFeed({ webhook: 'https://discord.com/api/webhooks/1/t' })), /never in this file/);
  assert.throws(() => validateConfig(oneFeed({ webhookUrl: 'https://discord.com/api/webhooks/1/t' })), /never in this file/);
});

test('webhookEnv must be a usable env var name', () => {
  assert.equal(validateConfig(oneFeed({ webhookEnv: 'HOOK_2' })).feeds[0].webhookEnv, 'HOOK_2');
  assert.throws(() => validateConfig(oneFeed({ webhookEnv: '2BAD' })), /environment variable name/);
});

test('structural problems throw early with a clear message', () => {
  assert.throws(() => validateConfig(null), /must be a JSON object/);
  assert.throws(() => validateConfig({}), /config\.feeds must be an array/);
  assert.throws(() => validateConfig({ feeds: [] }), /nothing to poll/);
  assert.throws(() => validateConfig(base([{ id: 'a', url: 'https://e.com/f', enabled: false }])), /every feed is disabled/);
});

test('numeric bounds are enforced', () => {
  assert.throws(() => validateConfig(oneFeed({ maxPerRun: 0 })), /maxPerRun/);
  assert.throws(() => validateConfig(oneFeed({ maxPerRun: 1.5 })), /maxPerRun/);
  assert.throws(() => validateConfig(oneFeed({ seenCap: 1 })), /seenCap/);
  assert.throws(() => validateConfig(oneFeed({ descriptionChars: 99999 })), /descriptionChars/);
});

test('a missing config file names the file', async () => {
  await assert.rejects(() => loadConfig('/nonexistent/feeds.json'), /config file not found/);
});

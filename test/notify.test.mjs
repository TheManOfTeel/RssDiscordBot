import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileNotify, validateConfig } from '../src/config.mjs';
import { groupForDelivery, mentionsFor } from '../src/runner.mjs';

const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';
const USER = '333333333333333333';
const NOW = Date.parse('2026-08-17T12:00:00Z');

const compile = (rules) => {
  const errors = [];
  const compiled = compileNotify(rules, 'notify', errors);
  assert.deepEqual(errors, [], 'expected a clean compile');
  return compiled;
};

const item = (over = {}) => ({
  id: over.title ?? 'x',
  title: 'Apple introduces iPhone 18',
  summary: 'A new phone.',
  categories: [],
  author: undefined,
  link: 'https://example.com/x',
  isoDate: new Date(NOW).toISOString(),
  ...over,
});

test('a rule with no when block pings on every item', () => {
  const notify = compile([{ roles: [ROLE_A] }]);
  assert.deepEqual(mentionsFor(item(), notify, NOW), { roles: [ROLE_A], users: [], text: undefined });
});

test('a rule with a when block pings only on matching items', () => {
  const notify = compile([{ roles: [ROLE_A], text: 'New hardware:', when: { include: ['\\biphone\\b'], fields: ['title'] } }]);
  assert.deepEqual(mentionsFor(item(), notify, NOW), { roles: [ROLE_A], users: [], text: 'New hardware:' });
  assert.equal(mentionsFor(item({ title: 'Apple announces Q3 earnings' }), notify, NOW), null);
});

test('overlapping rules union their targets and dedupe', () => {
  const notify = compile([
    { roles: [ROLE_A], when: { include: ['iphone'], fields: ['title'] } },
    { roles: [ROLE_A, ROLE_B], users: [USER], when: { include: ['apple'], fields: ['title'] } },
  ]);
  assert.deepEqual(mentionsFor(item(), notify, NOW), { roles: [ROLE_A, ROLE_B], users: [USER], text: undefined });
});

test('exclude works inside a ping rule', () => {
  const notify = compile([{ roles: [ROLE_A], when: { include: ['apple'], exclude: ['earnings'], fields: ['title'] } }]);
  assert.equal(mentionsFor(item({ title: 'Apple earnings call' }), notify, NOW), null);
});

test('a ping rule does not silently require a link', () => {
  const notify = compile([{ roles: [ROLE_A], when: { include: ['iphone'], fields: ['title'] } }]);
  assert.ok(mentionsFor(item({ link: '' }), notify, NOW), 'requireLink defaults false for notify rules');
});

test('a pinged item never shares a message with a silent one', () => {
  const notify = compile([{ roles: [ROLE_A], when: { include: ['ping me'], fields: ['title'] } }]);
  const queue = [
    item({ title: 'quiet 1' }),
    item({ title: 'ping me now' }),
    item({ title: 'quiet 2' }),
    item({ title: 'quiet 3' }),
  ];
  const groups = groupForDelivery(queue, notify, NOW);
  assert.deepEqual(
    groups.map((g) => [g.items.map((i) => i.title), g.mention?.roles ?? null]),
    [
      [['quiet 1'], null],
      [['ping me now'], [ROLE_A]],
      [['quiet 2', 'quiet 3'], null],
    ]
  );
});

test('a run of items sharing one mention becomes ONE message with ONE ping', () => {
  // The always-ping case: an 8-platform beta drop must be one notification, not eight.
  const notify = compile([{ roles: [ROLE_A], text: 'Pre-release:' }]);
  const queue = ['iOS beta', 'iPadOS beta', 'macOS beta', 'watchOS beta'].map((t) => item({ title: t }));
  const groups = groupForDelivery(queue, notify, NOW);
  assert.equal(groups.length, 1, 'one message');
  assert.equal(groups[0].items.length, 4, 'all four embeds ride along');
  assert.deepEqual(groups[0].mention.roles, [ROLE_A]);
});

test('items pinging DIFFERENT roles never share a message', () => {
  const notify = compile([
    { roles: [ROLE_A], when: { include: ['\\bios\\b'], fields: ['title'] } },
    { roles: [ROLE_B], when: { include: ['\\bmacos\\b'], fields: ['title'] } },
  ]);
  const groups = groupForDelivery([item({ title: 'iOS beta 3' }), item({ title: 'macOS beta 3' })], notify, NOW);
  assert.deepEqual(
    groups.map((g) => g.mention.roles),
    [[ROLE_A], [ROLE_B]],
    '@mac-betas must not be pinged for an iOS-only message'
  );
});

test('a shared-mention run still respects the 10-embed chunk', () => {
  const notify = compile([{ roles: [ROLE_A] }]);
  const groups = groupForDelivery(Array.from({ length: 23 }, (_, i) => item({ title: `t${i}` })), notify, NOW);
  assert.deepEqual(groups.map((g) => g.items.length), [10, 10, 3]);
  assert.equal(groups.every((g) => g.mention.roles[0] === ROLE_A), true);
});

test('an item matching both rules groups with neither single-rule item', () => {
  // Union semantics: "iOS on macOS" matches both, so its mention set is {A,B} — distinct
  // from {A} and from {B}, and it must get its own message.
  const notify = compile([
    { roles: [ROLE_A], when: { include: ['\\bios\\b'], fields: ['title'] } },
    { roles: [ROLE_B], when: { include: ['\\bmacos\\b'], fields: ['title'] } },
  ]);
  const queue = [item({ title: 'iOS beta' }), item({ title: 'iOS on macOS beta' }), item({ title: 'macOS beta' })];
  const groups = groupForDelivery(queue, notify, NOW);
  assert.deepEqual(groups.map((g) => g.mention.roles), [[ROLE_A], [ROLE_A, ROLE_B], [ROLE_B]]);
});

test('chronological order survives grouping', () => {
  const notify = compile([{ roles: [ROLE_A], when: { include: ['b'], fields: ['title'] } }]);
  const queue = ['a', 'b', 'c'].map((t) => item({ title: t }));
  const flat = groupForDelivery(queue, notify, NOW).flatMap((g) => g.items.map((i) => i.title));
  assert.deepEqual(flat, ['a', 'b', 'c']);
});

test('silent items still respect the 10-embed chunk', () => {
  const queue = Array.from({ length: 23 }, (_, i) => item({ title: `t${i}` }));
  const groups = groupForDelivery(queue, [], NOW);
  assert.deepEqual(groups.map((g) => g.items.length), [10, 10, 3]);
  assert.equal(groups.every((g) => g.mention === null), true);
});

test('no notify rules means no ping path at all', () => {
  assert.equal(mentionsFor(item(), [], NOW), null);
});

test('bad ids are rejected at config load with an actionable message', () => {
  const errors = [];
  compileNotify([{ roles: [123456789012345678] }], 'notify', errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a 17-20 digit STRING/);
  assert.match(errors[0], /Copy Role ID/);

  const short = [];
  compileNotify([{ roles: ['123'] }], 'notify', short);
  assert.equal(short.length, 1);
});

test('a rule that targets nobody is a config error', () => {
  const errors = [];
  compileNotify([{ when: { include: ['x'] } }], 'notify', errors);
  assert.match(errors[0], /needs at least one entry/);
});

test('an invalid regex in a when block is reported at load time', () => {
  const errors = [];
  compileNotify([{ roles: [ROLE_A], when: { include: ['(oops'] } }], 'notify', errors);
  assert.match(errors[0], /invalid regex/);
});

test('notify rules on defaults apply to every feed, plus the feed own rules', () => {
  const { feeds } = validateConfig({
    defaults: { notify: [{ users: [USER] }] },
    feeds: [{ id: 'a', url: 'https://e.com/f', notify: [{ roles: [ROLE_A], when: { include: ['x'] } }] }],
  });
  assert.equal(feeds[0].notify.length, 2);
  assert.deepEqual(feeds[0].notify[0].users, [USER]);
});

// Structural: this must keep passing after you swap the placeholder ids for real ones and
// after you add feeds. It asserts the rules are well-formed, not what they contain.
test('every notify rule in the committed feeds.json is well-formed', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const config = await loadConfig(new URL('../feeds.json', import.meta.url).pathname);
  for (const feed of config.feeds) {
    for (const [i, rule] of feed.notify.entries()) {
      const at = `${feed.id}.notify[${i}]`;
      assert.ok(rule.roles.length + rule.users.length > 0, `${at}: targets nobody`);
      for (const id of [...rule.roles, ...rule.users]) {
        assert.match(id, /^\d{17,20}$/, `${at}: ${id} is not a snowflake string`);
      }
      // A rule with no `when` pings on every item of that feed — legal, but loud.
      if (rule.when) assert.ok(Array.isArray(rule.when.include), `${at}.when: compiled`);
    }
  }
});

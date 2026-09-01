import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedMentionsFor,
  assertWebhookUrl,
  batchEmbeds,
  clip,
  embedCharCount,
  LIMITS,
  mentionContent,
  postEmbeds,
  sanitizeEmbed,
} from '../src/discord.mjs';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcDEF-token_1';

const okResponse = (headers = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers(headers),
  json: async () => ({ id: '1' }),
  text: async () => '{}',
});

function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };
}

test('clip respects the budget and returns undefined for empties', () => {
  assert.equal(clip('hello', 10), 'hello');
  assert.equal(clip('hello world', 8), 'hello w…');
  assert.equal(clip('hello world', 8).length, 8, 'the ellipsis is inside the budget');
  assert.equal(clip('hello world  x', 13), 'hello world…', 'no dangling whitespace before the ellipsis');
  assert.equal(clip('   ', 10), undefined);
  assert.equal(clip(undefined, 10), undefined);
});

test('sanitizeEmbed clamps every documented limit and drops empty members', () => {
  const embed = sanitizeEmbed({
    title: 'T'.repeat(400),
    description: 'D'.repeat(5000),
    author: { name: 'A'.repeat(400) },
    footer: { text: 'F'.repeat(3000) },
    fields: Array.from({ length: 30 }, () => ({ name: 'n'.repeat(300), value: 'v'.repeat(2000) })),
    color: 'nope',
    image: undefined,
  });
  assert.equal(embed.title.length, LIMITS.TITLE);
  assert.equal(embed.description.length, LIMITS.DESCRIPTION);
  assert.equal(embed.author.name.length, LIMITS.AUTHOR_NAME);
  assert.equal(embed.footer.text.length, LIMITS.FOOTER);
  assert.equal(embed.fields.length, LIMITS.FIELDS);
  assert.equal(embed.fields[0].name.length, LIMITS.FIELD_NAME);
  assert.equal(embed.fields[0].value.length, LIMITS.FIELD_VALUE);
  assert.equal('color' in embed, false, 'non-integer colour dropped rather than sent as NaN');
  assert.equal('image' in embed, false);
});

test('batchEmbeds caps at 10 per message', () => {
  const batches = batchEmbeds(Array.from({ length: 23 }, (_, i) => ({ title: `t${i}` })));
  assert.deepEqual(batches.map((b) => b.length), [10, 10, 3]);
});

test('batchEmbeds also respects the 6000-character total', () => {
  const big = { title: 'x'.repeat(200), description: 'y'.repeat(2000) }; // 2200 chars each
  const batches = batchEmbeds([big, big, big, big]);
  assert.deepEqual(batches.map((b) => b.length), [2, 2]);
  for (const batch of batches) {
    assert.ok(batch.reduce((n, e) => n + embedCharCount(e), 0) <= LIMITS.TOTAL_CHARS);
  }
});

test('a single oversized embed still ships as its own message', () => {
  const batches = batchEmbeds([{ description: 'z'.repeat(LIMITS.TOTAL_CHARS + 500) }]);
  assert.equal(batches.length, 1);
});

test('only real Discord webhook URLs are accepted', () => {
  assert.doesNotThrow(() => assertWebhookUrl(WEBHOOK));
  assert.doesNotThrow(() => assertWebhookUrl('https://discord.com/api/v10/webhooks/1/tok'));
  assert.throws(() => assertWebhookUrl('https://evil.example.com/api/webhooks/1/tok'), /not a Discord host/);
  assert.throws(() => assertWebhookUrl('http://discord.com/api/webhooks/1/tok'), /must be https/);
  assert.throws(() => assertWebhookUrl('https://discord.com/api/webhooks/notanid/tok'), /does not look like/);
  assert.throws(() => assertWebhookUrl('nonsense'), /not a valid URL/);
});

test('posts with wait=true and suppresses mentions', async () => {
  const { calls, fetchImpl } = recorder([okResponse()]);
  const result = await postEmbeds(WEBHOOK, [{ title: 'a' }], { fetchImpl, username: 'Feeds' });
  assert.deepEqual(result, { messages: 1, embeds: 1 });
  assert.match(calls[0].url, /\?wait=true$/);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(calls[0].body.username, 'Feeds');
});

test('@everyone in feed content cannot ping the channel', async () => {
  const { calls, fetchImpl } = recorder([okResponse()]);
  await postEmbeds(WEBHOOK, [{ title: '@everyone free money', description: '<@&role>' }], { fetchImpl });
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
});

test('honours retry_after on 429 then succeeds', async () => {
  const slept = [];
  const rateLimited = {
    ok: false,
    status: 429,
    headers: new Headers({ 'retry-after': '9' }),
    json: async () => ({ retry_after: 0.75, global: false }),
    text: async () => '{}',
  };
  const { calls, fetchImpl } = recorder([rateLimited, okResponse()]);
  const result = await postEmbeds(WEBHOOK, [{ title: 'a' }], { fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.equal(result.messages, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [1000], 'body retry_after (0.75s) wins over the header, plus 250ms margin');
});

test('gives up on 429 after maxRetries', async () => {
  const rateLimited = { ok: false, status: 429, headers: new Headers(), json: async () => ({ retry_after: 0 }), text: async () => '{}' };
  const { fetchImpl } = recorder([rateLimited]);
  await assert.rejects(
    () => postEmbeds(WEBHOOK, [{ title: 'a' }], { fetchImpl, sleep: async () => {}, maxRetries: 2 }),
    /Discord responded 429/
  );
});

test('retries 5xx with backoff but throws 4xx immediately', async () => {
  const slept = [];
  const serverError = { ok: false, status: 503, headers: new Headers(), text: async () => 'nope', json: async () => ({}) };
  const { calls, fetchImpl } = recorder([serverError, okResponse()]);
  await postEmbeds(WEBHOOK, [{ title: 'a' }], { fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [1000]);

  const badRequest = { ok: false, status: 400, headers: new Headers(), text: async () => '{"embeds":["bad"]}', json: async () => ({}) };
  const second = recorder([badRequest]);
  await assert.rejects(() => postEmbeds(WEBHOOK, [{ title: 'a' }], { fetchImpl: second.fetchImpl }), /Discord responded 400/);
  assert.equal(second.calls.length, 1, 'no retry on a client error');
});

test('waits when the rate-limit bucket is exhausted', async () => {
  const slept = [];
  const { fetchImpl } = recorder([okResponse({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.5' })]);
  await postEmbeds(WEBHOOK, [{ title: 'a' }], { fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(slept, [1600]);
});

test('inserts a gap between messages to stay under the per-channel cap', async () => {
  const slept = [];
  const { calls, fetchImpl } = recorder([okResponse()]);
  await postEmbeds(WEBHOOK, Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` })), {
    fetchImpl,
    sleep: async (ms) => slept.push(ms),
    minGapMs: 1300,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [1300, 1300]);
});

test('dry run posts nothing', async () => {
  const { calls, fetchImpl } = recorder([okResponse()]);
  const result = await postEmbeds(WEBHOOK, [{ title: 'a' }, { title: 'b' }], { fetchImpl, dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(result.messages, 1);
});

test('mentionContent builds role and user mentions, with optional lead text', () => {
  assert.equal(mentionContent({ roles: ['123456789012345678'] }), '<@&123456789012345678>');
  assert.equal(mentionContent({ users: ['123456789012345678'] }), '<@123456789012345678>');
  assert.equal(
    mentionContent({ roles: ['111111111111111111'], users: ['222222222222222222'], text: 'New hardware:' }),
    '<@&111111111111111111> <@222222222222222222> New hardware:'
  );
  assert.equal(mentionContent({}), undefined, 'nothing to ping means no content field at all');
  assert.ok(mentionContent({ roles: ['1'.repeat(18)], text: 'x'.repeat(1976) }).length <= LIMITS.CONTENT);
});

test('OS release summaries are grouped by version and platform', () => {
  const summary = '26.6.2 - iOS, iPadOS\n26.6.1 - macOS, watchOS\n26.6.0 - tvOS';
  assert.equal(mentionContent({}, summary), '26.6.2: iOS, iPadOS\n26.6.1: macOS, watchOS\n26.6.0: tvOS');
});

test('short multi-item Apple Dev title batches keep more than one sentence', () => {
  const summary = [
    'Updated Apple Developer Program License Agreement now available.',
    'Updates to age ratings for the Republic of Korea.',
    'Changes for apps in the European Union.',
    'Update: New domain for Sign in with Apple.',
  ].join(' ');
  const result = mentionContent({ roles: ['123456789012345678'] }, summary, true);
  const sentenceCount = (result.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length;
  assert.ok(sentenceCount >= 3, 'short title lists should keep most of their headlines instead of collapsing to a single sentence');
});

test('larger headline batches keep their size instead of being squeezed to 20%', () => {
  const summary = Array.from({ length: 5 }, (_, i) => `Apple headline ${i + 1} about Macs, iPhones, and AI.`).join(' ');
  const result = mentionContent({ roles: ['123456789012345678'] }, summary, true);
  const sentenceCount = (result.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length;
  assert.ok(sentenceCount >= 4, 'larger batches should respect their headline count rather than dropping to a 20% subset');
});

test('beta and RC release summaries keep their prerelease label', () => {
  const summary = 'iOS 26.2 beta 3 (23C5044f). macOS 26.2 beta 2 (25C5033e). watchOS 26.2 RC (23S5040c)';
  assert.equal(
    mentionContent({}, summary),
    '26.2 beta 3: iOS\n26.2 beta 2: macOS\n26.2 RC: watchOS'
  );
});

test('Apple-style mixed platform/version summaries are grouped by version', () => {
  const summary = 'iOS 18.7.9 (22H355). iPadOS 17.7.11 (21H461). iOS 16.7.16 (20H392). iPadOS 16.7.16 (20H392). iOS 15.8.8 (19H422). iPadOS 15.8.8 (19H422). tvOS 26.6 (23L773). watchOS 26.6 (23U67). iOS 26.6.1 (23G83). iPadOS 26.6.1 (23G83)';
  assert.equal(
    mentionContent({}, summary),
    '18.7.9: iOS\n17.7.11: iPadOS\n16.7.16: iOS, iPadOS\n15.8.8: iOS, iPadOS\n26.6: tvOS, watchOS\n26.6.1: iOS, iPadOS'
  );
});

test('allowedMentionsFor default-denies and allowlists only the given ids', () => {
  assert.deepEqual(allowedMentionsFor({}), { parse: [] });
  assert.deepEqual(allowedMentionsFor({ roles: ['9'.repeat(18)] }), { parse: [], roles: ['9'.repeat(18)] });
  assert.deepEqual(allowedMentionsFor({ roles: ['1'.repeat(18)], users: ['2'.repeat(18)] }), {
    parse: [],
    roles: ['1'.repeat(18)],
    users: ['2'.repeat(18)],
  });
});

test('a ping goes in content, never in the embed, and is allowlisted', async () => {
  const { calls, fetchImpl } = recorder([okResponse()]);
  const mention = { roles: ['123456789012345678'], text: 'New hardware:' };
  await postEmbeds(WEBHOOK, [{ title: 'iPhone 18' }], {
    fetchImpl,
    content: mentionContent(mention),
    allowedMentions: allowedMentionsFor(mention),
  });
  const body = calls[0].body;
  assert.equal(body.content, '<@&123456789012345678> New hardware:');
  assert.deepEqual(body.allowed_mentions, { parse: [], roles: ['123456789012345678'] });
  assert.equal(JSON.stringify(body.embeds).includes('<@&'), false, 'embeds carry no mention markup');
});

test('a split batch pings only once', async () => {
  const big = { title: 'x'.repeat(200), description: 'y'.repeat(2000) };
  const { calls, fetchImpl } = recorder([okResponse()]);
  await postEmbeds(WEBHOOK, [big, big, big, big], { fetchImpl, sleep: async () => {}, content: '<@&1>' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.content, '<@&1>');
  assert.equal('content' in calls[1].body, false, 'the continuation message must not re-ping');
});

test('mentions are still suppressed by default when no allowlist is given', async () => {
  const { calls, fetchImpl } = recorder([okResponse()]);
  await postEmbeds(WEBHOOK, [{ title: '@everyone' }], { fetchImpl });
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
});

test('an empty embed list is a no-op and never validates the URL', async () => {
  assert.deepEqual(await postEmbeds('garbage', [], {}), { messages: 0, embeds: 0 });
});

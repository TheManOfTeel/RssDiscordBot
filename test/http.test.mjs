import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError, fetchFeed, HttpError } from '../src/http.mjs';

/** A Response-shaped stub. Only what fetchFeed actually touches. */
function response(status, body, headers = {}) {
  return {
    status,
    statusText: status === 202 ? 'Accepted' : status === 200 ? 'OK' : String(status),
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
  };
}

const XML = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';
const noSleep = async () => {};

test('a 2xx with an empty body is retried, then thrown with the status preserved', async () => {
  const lines = [];
  let calls = 0;
  await assert.rejects(
    fetchFeed('https://feed.test/f', {
      retries: 1,
      sleep: noSleep,
      fetchImpl: async () => (calls++, response(202, '')),
      log: (line) => lines.push(line),
    }),
    (err) => {
      assert.ok(err instanceof HttpError);
      // The whole point. parseFeed's "empty response body" would have hidden this, which is
      // exactly how ESPN's 202 went undiagnosed.
      assert.equal(err.status, 202);
      assert.match(err.message, /empty body/);
      return true;
    }
  );
  assert.equal(calls, 2, 'initial attempt plus one retry');
  assert.ok(lines.every((l) => l.includes('0 bytes (soft block?)')));
  assert.ok(lines.every((l) => l.includes('202 Accepted')));
});

test('a whitespace-only body counts as empty', async () => {
  await assert.rejects(
    fetchFeed('https://feed.test/f', { retries: 0, sleep: noSleep, fetchImpl: async () => response(200, '\n  \t ') }),
    /empty body/
  );
});

test('a 2xx with a real body still returns normally', async () => {
  const result = await fetchFeed('https://feed.test/f', {
    retries: 0,
    sleep: noSleep,
    fetchImpl: async () => response(200, XML, { etag: 'W/"abc"', 'last-modified': 'Thu, 27 Aug 2026 14:00:00 GMT' }),
  });
  assert.equal(result.notModified, false);
  assert.equal(result.body, XML);
  assert.equal(result.etag, 'W/"abc"');
  assert.equal(result.lastModified, 'Thu, 27 Aug 2026 14:00:00 GMT');
});

test('a 304 short-circuits before any body handling', async () => {
  const result = await fetchFeed('https://feed.test/f', { retries: 0, sleep: noSleep, fetchImpl: async () => response(304, '') });
  assert.deepEqual(result, { notModified: true });
});

test('conditional headers are only sent when there is something to send', async () => {
  const capture = async (options) => {
    let headers;
    await fetchFeed('https://feed.test/f', {
      retries: 0,
      sleep: noSleep,
      ...options,
      fetchImpl: async (_url, o) => ((headers = o.headers), response(200, XML)),
    });
    return headers;
  };
  const withBoth = await capture({ etag: 'W/"1"', lastModified: 'Thu, 27 Aug 2026 14:00:00 GMT' });
  assert.equal(withBoth['if-none-match'], 'W/"1"');
  assert.equal(withBoth['if-modified-since'], 'Thu, 27 Aug 2026 14:00:00 GMT');
  const withNeither = await capture({});
  assert.equal(withNeither['if-none-match'], undefined);
  assert.equal(withNeither['if-modified-since'], undefined);
});

test('the feed request asks for XML and identifies itself honestly', async () => {
  let headers;
  await fetchFeed('https://feed.test/f', {
    retries: 0,
    sleep: noSleep,
    fetchImpl: async (_url, o) => ((headers = o.headers), response(200, XML)),
  });
  assert.match(headers.accept, /application\/rss\+xml/);
  assert.match(headers['user-agent'], /^rss-discord-bot/);
});

test('429 and 5xx retry, other 4xx throw immediately', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    await assert.rejects(fetchFeed('https://feed.test/f', { retries: 1, sleep: noSleep, fetchImpl: async () => (calls++, response(status, 'x')) }));
    assert.equal(calls, 2, `${status} should retry`);
  }
  let calls = 0;
  await assert.rejects(
    fetchFeed('https://feed.test/f', { retries: 2, sleep: noSleep, fetchImpl: async () => (calls++, response(404, 'nope')) }),
    (err) => err instanceof HttpError && err.status === 404
  );
  assert.equal(calls, 1, '404 must not be retried');
});

test('backoff is exponential and skipped on the first attempt', async () => {
  const waits = [];
  await assert.rejects(
    fetchFeed('https://feed.test/f', {
      retries: 3,
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: async () => response(500, 'x'),
    })
  );
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('a transport failure is retried and reported with the cause undici hides', async () => {
  const lines = [];
  await assert.rejects(
    fetchFeed('https://feed.test/f', {
      retries: 1,
      sleep: noSleep,
      fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
      log: (line) => lines.push(line),
    }),
    /ENOTFOUND/
  );
  assert.ok(lines.some((l) => l.includes('retrying')));
});

test('describeError unwraps the cause undici hides', () => {
  assert.equal(describeError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'fetch failed (ENOTFOUND)');
  assert.equal(describeError(new Error('plain')), 'plain');
});

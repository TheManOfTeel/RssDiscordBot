import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER_HEADERS, collectCookies, describeError, fetchFeed, HttpError } from '../src/http.mjs';

/** A Response-shaped stub. getSetCookie lives on Headers, not on the response. */
function response(status, body, { headers = {}, setCookie } = {}) {
  const h = new Headers(headers);
  if (setCookie) h.getSetCookie = () => setCookie;
  return {
    status,
    statusText: status === 202 ? 'Accepted' : status === 200 ? 'OK' : String(status),
    ok: status >= 200 && status < 300,
    headers: h,
    text: async () => body,
  };
}

const XML = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';

test('a 2xx with an empty body is retried and then thrown, with the status preserved', async () => {
  const lines = [];
  let calls = 0;
  await assert.rejects(
    fetchFeed('https://feed.test/f', {
      retries: 1,
      sleep: async () => {},
      fetchImpl: async () => (calls++, response(202, '')),
      log: (line) => lines.push(line),
    }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 202); // the whole point: parseFeed would have hidden this
      assert.match(err.message, /empty body/);
      return true;
    }
  );
  assert.equal(calls, 2); // initial attempt plus one retry
  assert.ok(lines.every((l) => l.includes('0 bytes (soft block?)')));
});

test('a whitespace-only body counts as empty', async () => {
  await assert.rejects(
    fetchFeed('https://feed.test/f', { retries: 0, sleep: async () => {}, fetchImpl: async () => response(200, '\n  \t ') }),
    /empty body/
  );
});

test('a 2xx with a real body still returns normally', async () => {
  const result = await fetchFeed('https://feed.test/f', {
    retries: 0,
    fetchImpl: async () => response(200, XML, { headers: { etag: 'W/"abc"', 'last-modified': 'Thu, 27 Aug 2026 14:00:00 GMT' } }),
  });
  assert.equal(result.notModified, false);
  assert.equal(result.body, XML);
  assert.equal(result.etag, 'W/"abc"');
  assert.equal(result.lastModified, 'Thu, 27 Aug 2026 14:00:00 GMT');
});

test('a 304 short-circuits before any body handling', async () => {
  const result = await fetchFeed('https://feed.test/f', { retries: 0, sleep: async () => {}, fetchImpl: async () => response(304, '') });
  assert.deepEqual(result, { notModified: true });
});

test('sessionUrl cookies are collected once and sent on the feed request', async () => {
  const seen = [];
  let sessionCalls = 0;
  await fetchFeed('https://feed.test/f', {
    retries: 2,
    sleep: async () => {},
    sessionUrl: 'https://feed.test/',
    fetchImpl: async (url, options) => {
      if (url === 'https://feed.test/') {
        sessionCalls++;
        return response(200, '', { setCookie: ['edition=espn-en-us; Path=/; Expires=Thu, 03 Sep 2026 17:03:08 GMT', 'country=us; Path=/'] });
      }
      seen.push(options.headers.cookie);
      return response(200, ''); // force all retries so we can prove the handshake is not repeated
    },
    log: () => {},
  }).catch(() => {});
  assert.equal(sessionCalls, 1, 'the handshake must not re-run per attempt');
  assert.equal(seen.length, 3);
  // Attributes are stripped; Expires contains a comma and must not be split on.
  assert.ok(seen.every((c) => c === 'edition=espn-en-us; country=us'));
});

test('a failing sessionUrl degrades to a plain request instead of failing the feed', async () => {
  const lines = [];
  const result = await fetchFeed('https://feed.test/f', {
    retries: 0,
    sessionUrl: 'https://feed.test/',
    fetchImpl: async (url) => {
      if (url === 'https://feed.test/') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return response(200, XML);
    },
    log: (line) => lines.push(line),
  });
  assert.equal(result.body, XML);
  assert.ok(lines.some((l) => l.includes('continuing without cookies')));
  assert.ok(lines.some((l) => l.includes('ENOTFOUND')));
});

test('a sessionUrl that sets no cookies sends no Cookie header at all', async () => {
  let sent = 'unset';
  await fetchFeed('https://feed.test/f', {
    retries: 0,
    sessionUrl: 'https://feed.test/',
    fetchImpl: async (url, options) => {
      if (url === 'https://feed.test/') return response(200, '', { setCookie: [] });
      sent = options.headers.cookie;
      return response(200, XML);
    },
    log: () => {},
  });
  assert.equal(sent, undefined);
});

test('browserHeaders adds sec-fetch-* but never overrides the feed Accept', async () => {
  let headers;
  await fetchFeed('https://feed.test/f', {
    retries: 0,
    browserHeaders: true,
    fetchImpl: async (_url, options) => ((headers = options.headers), response(200, XML)),
  });
  assert.equal(headers['sec-fetch-mode'], 'navigate');
  assert.equal(headers['user-agent'], BROWSER_HEADERS['user-agent']);
  // An XML feed request must still ask for XML, or a content-negotiating origin serves HTML.
  assert.match(headers.accept, /application\/rss\+xml/);
  assert.ok(!headers.accept.includes('text/html'));
});

test('browserHeaders is off by default, keeping the honest bot UA', async () => {
  let headers;
  await fetchFeed('https://feed.test/f', {
    retries: 0,
    fetchImpl: async (_url, options) => ((headers = options.headers), response(200, XML)),
  });
  assert.match(headers['user-agent'], /^rss-discord-bot/);
  assert.equal(headers['sec-fetch-mode'], undefined);
});

test('conditional headers are only sent when there is something to send', async () => {
  const capture = async (options) => {
    let headers;
    await fetchFeed('https://feed.test/f', {
      retries: 0,
      sleep: async () => {},
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

test('429 and 5xx retry, other 4xx throw immediately', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    await assert.rejects(fetchFeed('https://feed.test/f', { retries: 1, sleep: async () => {}, fetchImpl: async () => (calls++, response(status, 'x')) }));
    assert.equal(calls, 2, `${status} should retry`);
  }
  let calls = 0;
  await assert.rejects(
    fetchFeed('https://feed.test/f', { retries: 2, sleep: async () => {}, fetchImpl: async () => (calls++, response(404, 'nope')) }),
    (err) => err instanceof HttpError && err.status === 404
  );
  assert.equal(calls, 1, '404 must not be retried');
});

test('collectCookies returns an empty string rather than throwing', async () => {
  assert.equal(await collectCookies('https://feed.test/', { fetchImpl: async () => { throw new Error('boom'); } }), '');
  assert.equal(await collectCookies('https://feed.test/', { fetchImpl: async () => response(500, '') }), '');
});

test('describeError unwraps the cause undici hides', () => {
  assert.equal(describeError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'fetch failed (ENOTFOUND)');
  assert.equal(describeError(new Error('plain')), 'plain');
});

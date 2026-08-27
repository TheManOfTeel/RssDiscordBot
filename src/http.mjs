/**
 * Feed fetching with conditional GET.
 *
 * ETag / If-Modified-Since is not politeness theatre: a 304 costs no body transfer, no
 * parse, and no Actions time, and well-run feeds (GitHub, Reddit, most CMSes) support it.
 * A bot polling every 15 minutes without it is a bot that gets rate-limited or blocked.
 */

export const USER_AGENT = 'rss-discord-bot/1.0 (+https://github.com/features/actions)';

export class HttpError extends Error {
  constructor(status, statusText, url) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepDefault = sleep;

/**
 * A full browser header set, for edges that score on the ABSENCE of sec-fetch-* and
 * accept-language rather than on the User-Agent string. Opt in per feed with
 * `"browserHeaders": true`; it is not the default because most feeds want the honest UA.
 */
export const BROWSER_HEADERS = {
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

/**
 * GET a landing page purely to collect the cookies its edge hands out, and return them as a
 * Cookie header value.
 *
 * Why this exists: ESPN's www edge sets country / edition / edition-view / region / SWID on
 * every response and answers a cookie-less poller from a datacenter IP with 202 + zero bytes.
 * A browser completes that handshake implicitly on its first page view; a stateless feed
 * fetcher never does. One extra GET per run buys the session back.
 *
 * Returns '' on any failure — a handshake that does not work must degrade to the plain
 * request, not fail the feed.
 */
export async function collectCookies(sessionUrl, { fetchImpl = fetch, timeoutMs = 20_000, log = () => {} } = {}) {
  try {
    const res = await fetchImpl(sessionUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the connection is released rather than left half-read.
    await res.text().catch(() => '');
    // getSetCookie() is the only correct way to read repeated Set-Cookie headers; headers.get()
    // folds them into one comma-joined string that cannot be split safely (Expires contains a
    // comma). Available in Node 20+.
    const jar = (res.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
    log(`  session ${sessionUrl} -> ${res.status}, ${jar ? `${jar.split('; ').length} cookie(s)` : 'no cookies'}`);
    return jar;
  } catch (err) {
    log(`  session ${sessionUrl} -> failed (${describeError(err)}), continuing without cookies`);
    return '';
  }
}

/**
 * Node's fetch reports every transport failure as the useless string "fetch failed" and
 * hides the real reason (ENOTFOUND, ECONNREFUSED, certificate error) in `cause`. In a
 * scheduled job the log line is all you get, so unwrap it.
 */
export function describeError(err) {
  const cause = err?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : (err?.message ?? String(err));
}

/**
 * @returns {Promise<{notModified: boolean, body?: string, etag?: string|null, lastModified?: string|null}>}
 */
export async function fetchFeed(url, { etag, lastModified, timeoutMs = 20_000, retries = 2, sessionUrl, browserHeaders = false, fetchImpl = fetch, sleep: sleepImpl = sleepDefault, log = () => {} } = {}) {
  const headers = {
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': USER_AGENT,
    ...(browserHeaders ? BROWSER_HEADERS : {}),
  };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  // Once per fetchFeed call, not per attempt: a retry reuses the jar rather than re-handshaking.
  if (sessionUrl) {
    const jar = await collectCookies(sessionUrl, { fetchImpl, timeoutMs, log });
    if (jar) headers.cookie = jar;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepImpl(1000 * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal });
      if (res.status === 304) return { notModified: true };
      if (res.status === 429 || res.status >= 500) {
        // Transient by definition — retry. Anything else is our problem, not theirs.
        lastError = new HttpError(res.status, res.statusText, url);
        log(`  ${url} -> ${res.status}, retrying`);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, res.statusText, url);
      const body = await res.text();
      if (!body.trim()) {
        // A 2xx with no body is a soft block, not an answer, and it must not reach the parser:
        // "empty response body" from parseFeed hides the status, which is the one fact worth
        // having. Retrying is nearly free and costs one line of log if it fails again.
        lastError = new HttpError(res.status, `${res.statusText} with an empty body`, url);
        log(`  ${url} -> ${res.status} ${res.statusText}, 0 bytes (soft block?), retrying`);
        continue;
      }
      return {
        notModified: false,
        body,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = new Error(describeError(err), { cause: err });
      log(`  ${url} -> ${lastError.message}${attempt < retries ? ', retrying' : ''}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`failed to fetch ${url}`);
}

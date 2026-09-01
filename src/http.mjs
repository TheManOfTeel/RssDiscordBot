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
 * Unwrap Node's fetch error cause.
 * Transport failures like ECONNREFUSED are hidden in the cause; this extracts them.
 *
 * @param {Error} err - Error object
 * @returns {string} Human-readable error message
 */
export function describeError(err) {
  const cause = err?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : (err?.message ?? String(err));
}

/**
 * Fetch a feed with conditional GET (ETag/Last-Modified).
 * A 304 response returns { notModified: true } without fetching the body.
 *
 * @param {string} url - Feed URL
 * @param {object} options - { etag, lastModified, timeoutMs, retries, fetchImpl, sleep, log }
 * @returns {Promise<{notModified: boolean, body?: string, etag?: string|null, lastModified?: string|null}>}
 */
export async function fetchFeed(url, { etag, lastModified, timeoutMs = 20_000, retries = 2, fetchImpl = fetch, sleep: sleepImpl = sleepDefault, log = () => {} } = {}) {
  const headers = {
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': USER_AGENT,
  };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

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
        // A 2xx with no body is a soft block, not an answer, and it must never reach the
        // parser: parseFeed's "empty response body" hides the status, which is the one fact
        // worth having. ESPN's CloudFront answers datacenter egress with exactly this —
        // 202 Accepted, content-length 0, x-cache: Error from cloudfront.
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

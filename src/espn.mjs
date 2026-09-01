/**
 * ESPN site-API adapter: JSON news feeds normalised to the same item shape as feed.mjs.
 *
 * Exists because ESPN's RSS is unreachable from GitHub-hosted runners. Measured from a
 * runner (egress 40.78.174.131, Azure; CloudFront POP ORD58):
 *
 *   www.espn.com/espn/rss/nfl/news    -> 202 Accepted, 0 bytes, x-cache: Error from cloudfront
 *   www.espn.com/ (the homepage!)     -> 202 Accepted, 0 bytes
 *   www.espn.co.uk|in|com.au /rss/... -> 202 Accepted, 0 bytes
 *   site.api.espn.com/apis/site/v2/.. -> 200 OK, 235 KB of JSON
 *
 * The block is domain-wide on www.espn.*, not a feed-path rule, and the `via` chain on a
 * blocked response has no Varnish hop — CloudFront synthesises the 202 before the request
 * ever reaches ESPN's origin. So no header, cookie, UA, locale or retry fixes it; only a
 * different host does. Sending browser headers gets a 2015-byte HTML challenge page instead
 * of an empty body, which is not solvable in a zero-dependency Node script.
 *
 * Three things this buys beyond being reachable:
 *   - 50 articles per call (`?limit=50`, hard-capped there) vs 27 in the RSS
 *   - structured `categories` with type=team/athlete/contributor, so team notify rules can be
 *     exact (/^team:Cleveland Browns$/m) instead of regex-guessing at the headline
 *   - `published` is already ISO 8601, so no RFC 822 round-trip
 *
 * The id is deliberately `US-EN-<storyId>`, which is byte-identical to the RSS <guid> for
 * 26 of the 27 items in the RSS (the exception is a fantasy tool page whose link is not a
 * /story/_/id/N/ URL). That keeps a seen-list built from the RSS valid, so switching sources
 * does not re-post the backlog. Do not "improve" this to the bare numeric id.
 */

import { FeedFormatError } from './feed.mjs';

/** ESPN caps this server-side; asking for more silently returns 50. */
export const MAX_LIMIT = 50;

/** `type` values seen in the wild. `Media` entries are video clips, not articles. */
const MEDIA_TYPE = 'media';

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

/**
 * Build the ESPN site-API news URL.
 * Clamps the limit to ESPN's server-side cap (50).
 *
 * @param {string} sportPath - Sport path (e.g., 'football/nfl')
 * @param {number} limit - Requested article count (default MAX_LIMIT)
 * @returns {string} Full ESPN API URL
 */
export function espnNewsUrl(sportPath, limit = MAX_LIMIT) {
  const clamped = Math.min(Math.max(1, Number(limit) || MAX_LIMIT), MAX_LIMIT);
  return `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/news?limit=${clamped}`;
}

/**
 * The canonical article URL. `links.web.href` is the https www.espn.com permalink;
 * `links.mobile.href` is a plaintext http m.espn.go.com redirect, so it is never used.
 */
function linkOf(article) {
  const href = article.links?.web?.href ?? article.links?.api?.self?.href;
  return isHttpUrl(href) ? href.trim() : '';
}

/**
 * Prefer the editorial header image. `images` also carries video thumbnails (type=Media)
 * which are stills from a clip and read badly in an embed, so they are the last resort.
 */
function imageOf(article) {
  const images = Array.isArray(article.images) ? article.images : [];
  const header = images.find((i) => (i.type ?? '').toLowerCase() === 'header' && isHttpUrl(i.url));
  const any = images.find((i) => isHttpUrl(i.url));
  return (header ?? any)?.url?.trim();
}

/**
 * Flatten `categories` to strings the filter engine can match. filter.mjs joins arrays with
 * "\n" and compiles with the `m` flag, so each entry is anchorable on its own: an exclude of
 * /^San Francisco Giants$/m drops the baseball team without touching "Giants" headlines.
 *
 * `type:` prefixes are emitted alongside the bare value so a rule can be as loose or as tight
 * as it wants — /^team:Green Bay Packers$/m or just /Packers/.
 */
function categoriesOf(article) {
  const out = [];
  for (const category of Array.isArray(article.categories) ? article.categories : []) {
    const value = (category.description ?? '').trim();
    if (!value) continue;
    out.push(value);
    const type = (category.type ?? '').trim().toLowerCase();
    if (type) out.push(`${type}:${value}`);
  }
  return [...new Set(out)];
}

/** ISO 8601 already, but validate rather than trust: a bad date silently breaks maxAgeHours. */
function isoDateOf(article) {
  const raw = article.published ?? article.lastModified;
  if (!raw) return undefined;
  const ms = Date.parse(String(raw).trim());
  if (!Number.isFinite(ms)) return undefined;
  const year = new Date(ms).getUTCFullYear();
  if (year < 1990 || year > 2200) return undefined;
  return new Date(ms).toISOString();
}

function normaliseArticle(article) {
  const title = (article.headline ?? '').trim();
  const summary = (article.description ?? '').trim();
  return {
    // See the module comment: this format matches the RSS <guid>. Not the bare id.
    id: article.id != null ? `US-EN-${article.id}` : (linkOf(article) || title),
    title,
    link: linkOf(article),
    // No HTML in these fields, so content and summary are the same text. Kept as separate
    // keys because filter.mjs and buildEmbed both address them by name.
    content: summary,
    summary,
    author: (article.byline ?? '').trim() || undefined,
    categories: categoriesOf(article),
    isoDate: isoDateOf(article),
    image: imageOf(article),
  };
}

/**
 * Parse an ESPN site-API news response into the shape parseFeed returns, so runner.mjs,
 * filter.mjs and discord.mjs need no knowledge of which source produced an item.
 *
 * @param {string} jsonText raw response body
 * @param {{includeMedia?: boolean, includePremium?: boolean}} [options]
 *   includeMedia   keep type=Media video clips (default false — they have no article body)
 *   includePremium keep ESPN+ paywalled items (default false — the link is a paywall)
 * @returns {{format: string, title: string, link: string, items: object[]}}
 */
export function parseEspnNews(jsonText, { includeMedia = false, includePremium = false } = {}) {
  if (!jsonText || !String(jsonText).trim()) throw new FeedFormatError('empty response body');

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (err) {
    // site.api.espn.com is behind Akamai, which rate-limits per IP and answers a trip with a
    // 403 HTML "Access Denied" page. That is a 4xx so http.mjs rejects it first, but a cached
    // or proxied variant could arrive as 200 — say what actually came back instead of
    // "Unexpected token '<'".
    const head = String(jsonText).trimStart().slice(0, 80);
    throw new FeedFormatError(`response is not JSON (starts with ${JSON.stringify(head)}) — ${err.message}`);
  }

  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FeedFormatError('expected a JSON object at the top level');
  }
  if (!Array.isArray(payload.articles)) {
    throw new FeedFormatError(`no "articles" array in the response (keys: ${Object.keys(payload).join(', ') || 'none'})`);
  }

  const articles = payload.articles.filter((article) => {
    if (article == null || typeof article !== 'object') return false;
    if (!includeMedia && (article.type ?? '').toLowerCase() === MEDIA_TYPE) return false;
    if (!includePremium && article.premium === true) return false;
    return true;
  });

  return {
    format: 'espn-json',
    title: typeof payload.header === 'string' ? payload.header : '',
    link: isHttpUrl(payload.link?.web?.href) ? payload.link.web.href : '',
    items: articles.map(normaliseArticle),
  };
}

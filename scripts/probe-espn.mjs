#!/usr/bin/env node
/**
 * One question: can we keep the standard ESPN RSS URL, and if so how?
 *
 * ESPN's www edge answers the GitHub Actions egress with 202 + zero bytes while answering a
 * residential IP with 200 + valid XML. Everything about the request is identical between the
 * two — same Node 24, same undici, same TLS fingerprint, same IPv4 path (verified: both
 * resolve to CloudFront A records and connect over v4, so the AAAA records are a red herring).
 * That leaves three candidate causes, and they are only distinguishable from the runner:
 *
 *   1. IP reputation at CloudFront/Varnish  -> no request change helps; change host or egress
 *   2. a session the edge expects           -> the cookie-handshake case below fixes it
 *   3. a header-scoring WAF                 -> the browser-headers case below fixes it
 *
 * Plus the case that needs no diagnosis at all: the regional hosts are the same Varnish +
 * CloudFront stack but different distributions, serving the SAME stories as standard RSS —
 * 25/25 of co.uk's items are the US feed's story ids with a GB-EN- prefix instead of US-EN-.
 *
 * Read the summary at the bottom. Anything marked USABLE is a fix you can ship. Prefer the
 * cases in order: a fixed us-rss-* case beats switching host, which beats leaving RSS.
 */

const BOT_UA = 'rss-discord-bot/1.0 (+https://github.com/features/actions)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const XML_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5';

const US_RSS = 'https://www.espn.com/espn/rss/nfl/news';

/** Identifies which CDN answered and whether it was a soft block rather than an answer. */
const INTERESTING = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'age', 'vary', 'server', 'via', 'x-cache', 'x-amz-cf-id', 'x-amz-cf-pop', 'set-cookie'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shape(text) {
  const head = text.trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed')) return 'XML';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  if (head.startsWith('<')) return 'HTML';
  return text.length === 0 ? 'EMPTY' : 'other';
}

/**
 * A full browser header set. If a WAF is scoring on the ABSENCE of sec-fetch-* and
 * accept-language rather than on the UA string, this is the case that flips.
 */
const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': BROWSER_UA,
};

async function request(url, headers) {
  const started = process.hrtime.bigint();
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  return { res, text, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) };
}

function report(name, { res, text, ms }, note = '') {
  const usable = res.ok && text.trim() && shape(text) !== 'HTML';
  console.log(`\n### ${name} — ${usable ? 'USABLE' : 'BLOCKED'}${note ? ` (${note})` : ''}`);
  console.log(`  ${res.status} ${res.statusText} in ${ms}ms | ${text.length} bytes | ${shape(text)}`);
  for (const header of INTERESTING) {
    const value = res.headers.get(header);
    if (value) console.log(`  ${header}: ${value.slice(0, 180)}`);
  }
  if (text.length > 0) console.log(`  preview: ${JSON.stringify(text.slice(0, 140))}`);
  return { name, usable, status: res.status, bytes: text.length };
}

/**
 * Collect the cookies the edge hands out on a normal page view, then replay them on the feed
 * request. ESPN's edge sets country / edition / edition-view / region / SWID on the way in; if
 * the 202 is an edition handshake the client never completes, this is the whole fix.
 */
async function cookieHandshake() {
  const landing = await fetch('https://www.espn.com/', {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  await landing.text();
  const jar = landing.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  console.log(`\n  [handshake] landing page ${landing.status}, cookies collected: ${jar ? jar.slice(0, 180) : '(none)'}`);
  return request(US_RSS, { accept: XML_ACCEPT, 'user-agent': BOT_UA, cookie: jar });
}

async function egressIp() {
  for (const url of ['https://api.ipify.org', 'https://checkip.amazonaws.com']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return (await res.text()).trim();
    } catch { /* try the next one */ }
  }
  return '(unknown)';
}

console.log(`node ${process.version}`);
console.log(`egress ip: ${await egressIp()}`);

const results = [];
const run = async (name, fn, note) => {
  try {
    results.push(report(name, await fn(), note));
  } catch (err) {
    console.log(`\n### ${name} — ERROR`);
    console.log(`  ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
    results.push({ name, usable: false, status: 0, bytes: 0 });
  }
};

// --- Can the US RSS URL be saved? -------------------------------------------------------
await run('us-rss-baseline', () => request(US_RSS, { accept: XML_ACCEPT, 'user-agent': BOT_UA }),
  'the exact request the bot makes today');

await run('us-rss-browser-headers', () => request(US_RSS, BROWSER_HEADERS),
  'flips if a WAF scores on absent sec-fetch-*');

await run('us-rss-cookie-handshake', cookieHandshake,
  'flips if the 202 is an unfinished edition handshake');

await run('us-rss-cache-buster', () => request(`${US_RSS}?_cb=1`, { accept: XML_ACCEPT, 'user-agent': BOT_UA }),
  'flips if a 202 is cached against the bare path');

// cache-control on a good response is max-age=36, so a >36s gap outlives any cached 202.
// Danny's live backoff is 1s then 2s, which cannot outlive it.
console.log('\n  [waiting 45s to outlive the 36s edge TTL...]');
await sleep(45_000);
await run('us-rss-after-45s', () => request(US_RSS, { accept: XML_ACCEPT, 'user-agent': BOT_UA }),
  'flips if the 202 is a short-lived cache artifact');

// --- Same stories, standard RSS, zero new code ------------------------------------------
for (const [name, url] of [
  ['uk-rss', 'https://www.espn.co.uk/espn/rss/nfl/news'],
  ['in-rss', 'https://www.espn.in/espn/rss/nfl/news'],
  ['au-rss', 'https://www.espn.com.au/espn/rss/nfl/news'],
]) {
  await run(name, () => request(url, { accept: XML_ACCEPT, 'user-agent': BOT_UA }), 'drop-in for parseFeed');
}

// --- Last resort: only worth writing a JSON adapter for if every RSS case above fails ---
await run('json-api-nfl', () => request('https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50', { accept: 'application/json', 'user-agent': BOT_UA }),
  'would need a JSON adapter, not in the tree');
await run('json-api-cfb', () => request('https://site.api.espn.com/apis/site/v2/sports/football/college-football/news?limit=50', { accept: 'application/json', 'user-agent': BOT_UA }),
  'would need a JSON adapter, not in the tree');

console.log('\n\n=== summary ===');
for (const r of results) {
  console.log(`${(r.usable ? 'USABLE' : 'BLOCKED').padEnd(8)} ${String(r.status).padEnd(4)} ${String(r.bytes).padEnd(8)} ${r.name}`);
}

const usable = results.filter((r) => r.usable).map((r) => r.name);
console.log(`\nusable from this egress: ${usable.length > 0 ? usable.join(', ') : 'NONE'}`);

const usRssFix = usable.find((n) => n.startsWith('us-rss') && n !== 'us-rss-baseline');
if (usable.includes('us-rss-baseline')) console.log('\n=> The US RSS URL works from here. The 202 was not reproducible.');
else if (usRssFix) console.log(`\n=> KEEP THE US RSS URL. Apply what "${usRssFix}" changed.`);
else if (usable.some((n) => n.endsWith('-rss'))) console.log('\n=> Keep standard RSS, switch host. No code change needed.');
else if (usable.some((n) => n.startsWith('json-api'))) console.log('\n=> RSS is dead from this egress. Only then is a JSON adapter worth writing.');
else console.log('\n=> Nothing ESPN is reachable. Proxy through a Worker, or change source.');

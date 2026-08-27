import assert from 'node:assert/strict';
import { test } from 'node:test';
import { espnNewsUrl, MAX_LIMIT, parseEspnNews } from '../src/espn.mjs';
import { FeedFormatError } from '../src/feed.mjs';

/** Trimmed from a real site.api.espn.com/apis/site/v2/sports/football/nfl/news response. */
const PAYLOAD = JSON.stringify({
  header: 'NFL News',
  link: { web: { href: 'https://www.espn.com/nfl/' } },
  articles: [
    {
      id: 49743030,
      type: 'HeadlineNews',
      headline: 'Source: Testteam adding TE testplayer on one-year deal',
      description: 'The Testteam are signing tight end testplayer to a one-year contract.',
      published: '2026-08-27T16:44:56Z',
      lastModified: '2026-08-27T17:02:11Z',
      byline: 'testauthor',
      images: [
        { type: 'Media', url: 'https://a.example.test/clip-still.jpg' },
        { type: 'header', url: 'https://a.example.test/header.jpg' },
      ],
      categories: [
        { type: 'topic', description: 'news' },
        { type: 'league', description: 'NFL' },
        { type: 'team', description: 'Test Testteam', teamId: 9 },
        { type: 'athlete', description: 'testplayer' },
        { type: 'contributor', description: '' },
      ],
      links: {
        web: { href: 'https://www.espn.com/nfl/story/_/id/49743030/source-testteam-adding-te-testplayer' },
        mobile: { href: 'http://m.espn.go.com/nfl/story?storyId=49743030' },
      },
    },
    {
      id: 49743031,
      type: 'Media',
      headline: 'A video clip',
      description: 'clip',
      published: '2026-08-27T15:00:00Z',
      links: { web: { href: 'https://www.espn.com/video/clip/_/id/49743031' } },
    },
    {
      id: 49743032,
      type: 'Story',
      headline: 'An ESPN+ story',
      description: 'paywalled',
      premium: true,
      published: '2026-08-27T14:00:00Z',
      links: { web: { href: 'https://www.espn.com/nfl/insider/story/_/id/49743032' } },
    },
  ],
});

test('normalises an article to the same shape parseFeed produces', () => {
  const { format, title, link, items } = parseEspnNews(PAYLOAD);
  assert.equal(format, 'espn-json');
  assert.equal(title, 'NFL News');
  assert.equal(link, 'https://www.espn.com/nfl/');
  assert.equal(items.length, 1); // the Media clip and the premium story are dropped

  const [item] = items;
  assert.equal(item.title, 'Source: Testteam adding TE testplayer on one-year deal');
  assert.equal(item.link, 'https://www.espn.com/nfl/story/_/id/49743030/source-testteam-adding-te-testplayer');
  assert.equal(item.summary, 'The Testteam are signing tight end testplayer to a one-year contract.');
  assert.equal(item.content, item.summary);
  assert.equal(item.author, 'testauthor');
  assert.equal(item.isoDate, '2026-08-27T16:44:56.000Z'); // published wins over lastModified
});

test('the id matches the RSS <guid> format so a cutover keeps the seen list valid', () => {
  const [item] = parseEspnNews(PAYLOAD).items;
  assert.equal(item.id, 'US-EN-49743030');
});

test('prefers the editorial header image over a video still', () => {
  const [item] = parseEspnNews(PAYLOAD).items;
  assert.equal(item.image, 'https://a.example.test/header.jpg');
});

test('never uses the plaintext-http mobile link', () => {
  const [item] = parseEspnNews(PAYLOAD).items;
  assert.ok(item.link.startsWith('https://'));
  assert.ok(!item.link.includes('m.espn.go.com'));
});

test('categories carry both the bare value and a type-prefixed form, and drop blanks', () => {
  const [item] = parseEspnNews(PAYLOAD).items;
  assert.ok(item.categories.includes('Test Testteam'));
  assert.ok(item.categories.includes('team:Test Testteam'));
  assert.ok(item.categories.includes('league:NFL'));
  // A blank description contributes nothing, not "contributor:".
  assert.ok(!item.categories.some((c) => c === '' || c === 'contributor:'));
});

test('opting in keeps media clips and premium stories', () => {
  assert.equal(parseEspnNews(PAYLOAD, { includeMedia: true }).items.length, 2);
  assert.equal(parseEspnNews(PAYLOAD, { includePremium: true }).items.length, 2);
  assert.equal(parseEspnNews(PAYLOAD, { includeMedia: true, includePremium: true }).items.length, 3);
});

test('falls back to lastModified when published is absent, and rejects absurd dates', () => {
  const only = (article) => parseEspnNews(JSON.stringify({ articles: [article] })).items[0];
  assert.equal(only({ id: 1, headline: 't', lastModified: '2026-01-02T03:04:05Z' }).isoDate, '2026-01-02T03:04:05.000Z');
  assert.equal(only({ id: 2, headline: 't', published: '0001-01-01T00:00:00Z' }).isoDate, undefined);
  assert.equal(only({ id: 3, headline: 't', published: 'not a date' }).isoDate, undefined);
  assert.equal(only({ id: 4, headline: 't' }).isoDate, undefined);
});

test('an empty body is a FeedFormatError, matching parseFeed', () => {
  assert.throws(() => parseEspnNews(''), FeedFormatError);
  assert.throws(() => parseEspnNews('   '), FeedFormatError);
});

test('an Akamai HTML block page reports what actually arrived, not a JSON syntax error', () => {
  const denied = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>...';
  assert.throws(() => parseEspnNews(denied), (err) => {
    assert.ok(err instanceof FeedFormatError);
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /Access Denied/);
    return true;
  });
});

test('a well-formed response with no articles array is rejected with its keys', () => {
  assert.throws(() => parseEspnNews('{"header":"NFL News"}'), (err) => {
    assert.ok(err instanceof FeedFormatError);
    assert.match(err.message, /no "articles" array/);
    assert.match(err.message, /header/);
    return true;
  });
  assert.throws(() => parseEspnNews('[]'), FeedFormatError);
  assert.throws(() => parseEspnNews('null'), FeedFormatError);
});

test('espnNewsUrl clamps to the server-side cap instead of silently overshooting', () => {
  assert.equal(espnNewsUrl('football/nfl'), `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=${MAX_LIMIT}`);
  assert.ok(espnNewsUrl('football/nfl', 500).endsWith(`limit=${MAX_LIMIT}`));
  assert.ok(espnNewsUrl('football/nfl', 0).endsWith(`limit=${MAX_LIMIT}`));
  assert.ok(espnNewsUrl('football/college-football', 10).endsWith('college-football/news?limit=10'));
});

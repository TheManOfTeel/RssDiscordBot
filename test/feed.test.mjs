import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeedFormatError, parseFeed, toIsoDate } from '../src/feed.mjs';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Shipping TypeScript 6 &amp; friends</title>
      <link>https://example.com/ts6</link>
      <guid isPermaLink="false">tag:example.com,2026:1</guid>
      <pubDate>Tue, 04 Aug 2026 12:30:00 GMT</pubDate>
      <dc:creator>Danny</dc:creator>
      <category>typescript</category>
      <category>releases</category>
      <description>&lt;p&gt;It&amp;#39;s &lt;b&gt;out&lt;/b&gt;.&lt;/p&gt;</description>
      <enclosure url="https://example.com/a.png" type="image/png" length="1"/>
    </item>
    <item>
      <title>No guid here</title>
      <link>https://example.com/second</link>
      <content:encoded><![CDATA[<p>Full <i>content</i> wins over description.</p>]]></content:encoded>
      <description>short</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://example.com/feed.atom"/>
  <link rel="alternate" href="https://example.com/"/>
  <entry>
    <title>Atom entry</title>
    <id>urn:uuid:1234</id>
    <link rel="enclosure" href="https://example.com/big.mp3"/>
    <link rel="alternate" href="https://example.com/atom-entry"/>
    <published>2026-08-01T10:00:00Z</published>
    <updated>2026-08-02T10:00:00Z</updated>
    <author><name>Ada</name></author>
    <category term="dotnet"/>
    <summary type="html">&lt;p&gt;Summary text&lt;/p&gt;</summary>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com"><title>RDF feed</title></channel>
  <item rdf:about="https://example.com/rdf-1">
    <title>RDF item</title>
    <link>https://example.com/rdf-1</link>
    <dc:date>2026-07-30T08:00:00+00:00</dc:date>
  </item>
</rdf:RDF>`;

test('parses RSS 2.0 including dc:creator, categories and content:encoded', () => {
  const feed = parseFeed(RSS2);
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, 'Example Blog');
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.equal(first.title, 'Shipping TypeScript 6 & friends');
  assert.equal(first.id, 'tag:example.com,2026:1');
  assert.equal(first.link, 'https://example.com/ts6');
  assert.equal(first.author, 'Danny');
  assert.deepEqual(first.categories, ['typescript', 'releases']);
  assert.equal(first.isoDate, '2026-08-04T12:30:00.000Z');
  assert.equal(first.summary, "It's out.");
  assert.equal(first.image, 'https://example.com/a.png');

  // No guid -> falls back to the link.
  assert.equal(second.id, 'https://example.com/second');
  assert.equal(second.summary, 'Full content wins over description.');
});

test('parses Atom, preferring rel=alternate over enclosure links', () => {
  const feed = parseFeed(ATOM);
  assert.equal(feed.format, 'atom');
  const [entry] = feed.items;
  assert.equal(entry.id, 'urn:uuid:1234');
  assert.equal(entry.link, 'https://example.com/atom-entry');
  assert.equal(entry.author, 'Ada');
  assert.deepEqual(entry.categories, ['dotnet']);
  assert.equal(entry.isoDate, '2026-08-01T10:00:00.000Z', 'published beats updated');
  assert.equal(entry.summary, 'Summary text');
});

test('parses RSS 1.0 / RDF where items sit beside the channel', () => {
  const feed = parseFeed(RDF);
  assert.equal(feed.format, 'rdf');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].link, 'https://example.com/rdf-1');
  assert.equal(feed.items[0].isoDate, '2026-07-30T08:00:00.000Z');
});

test('a permalink guid becomes the link when <link> is absent', () => {
  const feed = parseFeed(`<rss><channel><item>
    <title>t</title><guid>https://example.com/from-guid</guid>
  </item></channel></rss>`);
  assert.equal(feed.items[0].link, 'https://example.com/from-guid');
  assert.equal(feed.items[0].id, 'https://example.com/from-guid');
});

test('isPermaLink="false" guid is not used as a link', () => {
  const feed = parseFeed(`<rss><channel><item>
    <title>t</title><guid isPermaLink="false">https://example.com/x</guid>
  </item></channel></rss>`);
  assert.equal(feed.items[0].link, '');
});

test('ids are stable and content-derived when nothing usable exists', () => {
  const xml = '<rss><channel><item><title>Only a title</title></item></channel></rss>';
  const a = parseFeed(xml).items[0].id;
  const b = parseFeed(xml).items[0].id;
  assert.match(a, /^sha256:[0-9a-f]{32}$/);
  assert.equal(a, b);
  const other = parseFeed('<rss><channel><item><title>Different</title></item></channel></rss>').items[0].id;
  assert.notEqual(a, other);
});

test('rejects garbage and empty input', () => {
  assert.throws(() => parseFeed(''), FeedFormatError);
  assert.throws(() => parseFeed('not xml at all'), FeedFormatError);
  assert.throws(() => parseFeed('<html><body>404</body></html>'), FeedFormatError);
});

test('bad dates degrade to undefined instead of Invalid Date', () => {
  assert.equal(toIsoDate('not a date'), undefined);
  assert.equal(toIsoDate(''), undefined);
  assert.equal(toIsoDate('0001-01-01T00:00:00Z'), undefined, 'placeholder years rejected');
  assert.equal(toIsoDate('Tue, 04 Aug 2026 12:30:00 -0400'), '2026-08-04T16:30:00.000Z');
});

test('unescaped ampersands in a feed do not lose the item', () => {
  const feed = parseFeed('<rss><channel><item><title>Tom & Jerry</title><link>https://e.com/a</link></item></channel></rss>');
  assert.equal(feed.items[0].title, 'Tom & Jerry');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeedFormatError } from '../src/feed.mjs';
import { parseJsonFeed } from '../src/json.mjs';

test('maps JSON paths and URL templates into the shared feed item shape', () => {
  const payload = JSON.stringify({
    vulnerabilities: [{
      cve: { id: 'CVE-2026-1234' },
      name: 'Example vulnerability',
      description: 'A short description',
      vendor: { name: 'Example vendor' },
      added: '2026-10-30',
      tags: ['security', 'web'],
    }],
  });
  const parsed = parseJsonFeed(payload, {
    name: 'Test JSON feed',
    url: 'https://example.test/data.json',
    parserOptions: {
      rootPath: 'vulnerabilities',
      mapping: {
        id: 'cve.id',
        title: 'name',
        link: 'https://nvd.nist.gov/vuln/detail/{cve.id}',
        summary: 'description',
        author: 'vendor.name',
        isoDate: 'added',
        categories: 'tags',
      },
    },
  });

  assert.equal(parsed.format, 'json');
  assert.equal(parsed.title, 'Test JSON feed');
  assert.equal(parsed.items.length, 1);
  assert.deepEqual(parsed.items[0], {
    id: 'CVE-2026-1234',
    title: 'Example vulnerability',
    link: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1234',
    summary: 'A short description',
    content: 'A short description',
    author: 'Example vendor',
    categories: ['security', 'web'],
    isoDate: '2026-10-30T00:00:00.000Z',
    image: undefined,
  });
});

test('uses stable fallback IDs when an item has no mapped ID', () => {
  const payload = '[{"title":"A"}]';
  const parse = () => parseJsonFeed(payload).items[0].id;
  assert.equal(parse(), parse());
  assert.match(parse(), /^json:[a-f0-9]{32}$/);
  assert.match(parseJsonFeed('[{"id":""}]').items[0].id, /^json:[a-f0-9]{32}$/);
});

test('applies default field mappings and normalizes optional values', () => {
  const parsed = parseJsonFeed(JSON.stringify([{
    id: 123,
    title: 'Numeric fields',
    link: null,
    summary: 42,
    content: 'Full content',
    author: 7,
    categories: 'security',
    isoDate: 'not a date',
    image: 9,
  }]));

  assert.deepEqual(parsed.items[0], {
    id: '123',
    title: 'Numeric fields',
    link: '',
    summary: '42',
    content: 'Full content',
    author: '7',
    categories: ['security'],
    isoDate: undefined,
    image: '9',
  });
  const missing = parseJsonFeed('[{}]').items[0];
  assert.match(missing.id, /^json:[a-f0-9]{32}$/);
  assert.deepEqual(missing, {
    id: missing.id,
    title: '(untitled)',
    link: '',
    summary: '',
    content: '',
    author: undefined,
    categories: [],
    isoDate: undefined,
    image: undefined,
  });
});

test('supports top-level parser options, nested paths and sparse mapping templates', () => {
  const parsed = parseJsonFeed(JSON.stringify({ records: [{ metadata: 'plain text', tags: [null, '', 'security', 'security'] }] }), {
    rootPath: 'records',
    mapping: {
      title: 'metadata.title',
      id: 'missing.id',
      link: 'https://example.test/{missing.value}',
      categories: 'tags',
    },
  });

  assert.equal(parsed.items[0].title, '(untitled)');
  assert.match(parsed.items[0].id, /^json:[a-f0-9]{32}$/);
  assert.equal(parsed.items[0].link, 'https://example.test/');
  assert.deepEqual(parsed.items[0].categories, ['security']);
});

test('accepts empty item arrays and null mapping entries', () => {
  assert.deepEqual(parseJsonFeed('[]').items, []);
  const parsed = parseJsonFeed('[{"title":"Default title"}]', {
    parserOptions: { mapping: { title: null } },
  });
  assert.equal(parsed.items[0].title, 'Default title');

  const invalidMapping = parseJsonFeed('[{}]', {
    parserOptions: { mapping: { title: 7 } },
  });
  assert.equal(invalidMapping.items[0].title, '(untitled)');
});

test('rejects invalid item values', () => {
  for (const item of [null, 1, []]) {
    assert.throws(() => parseJsonFeed(JSON.stringify([item])), /item 0 is not a JSON object/);
  }
});

test('reports invalid JSON and invalid array roots as feed format errors', () => {
  assert.throws(() => parseJsonFeed(''), FeedFormatError);
  assert.throws(() => parseJsonFeed('  '), /empty response body/);
  assert.throws(() => parseJsonFeed('<html>blocked</html>'), /not JSON/);
  assert.throws(() => parseJsonFeed('{"items":[]}', { parserOptions: { rootPath: 'records' } }), /expected a JSON array/);
  assert.throws(() => parseJsonFeed('{}'), /expected a JSON array$/);
  assert.throws(() => parseJsonFeed('{}', { rootPath: '  ' }), /expected a JSON array at/);
  assert.throws(() => parseJsonFeed('{}', { rootPath: 3 }), /expected a JSON array at/);
  assert.throws(() => parseJsonFeed('null', { rootPath: 'records' }), /expected a JSON array at/);
  assert.throws(() => parseJsonFeed('42', { rootPath: 'records' }), /expected a JSON array at/);
});
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeedFormatError } from '../src/feed.mjs';
import { parseAppleStatus } from '../src/apple-status.mjs';

const payload = (event) => JSON.stringify({
  services: [
    { serviceName: 'Apple Music', redirectUrl: null, events: [event] },
    { serviceName: 'Apple TV', redirectUrl: 'https://www.apple.com/tv/', events: [] },
  ],
});

const event = {
  messageId: 'incident-1',
  statusType: 'Outage',
  message: 'Some users may be experiencing an issue.',
  datePosted: '2026-11-10T17:11:00-08:00',
  startDate: '2026-11-10T16:00:00-08:00',
  endDate: null,
  usersAffected: 'Some users',
  affectedServices: ['Apple Music', 'Podcasts', 'Apple Music'],
  eventStatus: 'ongoing',
};

test('normalizes Apple service events and their affected services', () => {
  const parsed = parseAppleStatus(payload(event), { name: 'Apple Status' });
  assert.equal(parsed.format, 'apple-status');
  assert.equal(parsed.title, 'Apple Status');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'Apple Music: Outage (ongoing)');
  assert.equal(parsed.items[0].incidentId, parseAppleStatus(payload({ ...event, eventStatus: 'resolved' })).items[0].incidentId);
  assert.equal(parsed.items[0].eventStatus, 'ongoing');
  assert.equal(parsed.items[0].link, 'https://www.apple.com/support/systemstatus/');
  assert.match(parsed.items[0].summary, /Some users may be experiencing an issue\./);
  assert.match(parsed.items[0].summary, /Affected services: Apple Music, Podcasts/);
  assert.deepEqual(parsed.items[0].categories, ['Outage', 'ongoing']);
  assert.equal(parsed.items[0].isoDate, '2026-11-11T01:11:00.000Z');
});

test('uses a service redirect and gives changed incident revisions new IDs', () => {
  const source = JSON.parse(payload(event));
  source.services[1].events = [{ ...event, messageId: 'incident-2' }];
  const withRedirect = parseAppleStatus(JSON.stringify(source));
  assert.equal(withRedirect.items[1].link, 'https://www.apple.com/tv/');

  const updated = parseAppleStatus(payload({ ...event, eventStatus: 'resolved', endDate: '2026-11-10T17:30:00-08:00' }));
  assert.notEqual(updated.items[0].id, withRedirect.items[0].id);
  assert.match(updated.items[0].title, /\(resolved\)$/);
});

test('returns no items when services have no events', () => {
  assert.deepEqual(parseAppleStatus('{"services":[{"serviceName":"Apple Music","events":[]}]}').items, []);
});

test('rejects invalid Apple status payloads', () => {
  assert.throws(() => parseAppleStatus(''), FeedFormatError);
  assert.throws(() => parseAppleStatus('<html>blocked</html>'), /not JSON/);
  assert.throws(() => parseAppleStatus('{"items":[]}'), /services array/);
  assert.throws(() => parseAppleStatus('{"services":[{"serviceName":"Apple Music","events":[null]}]}'), /invalid event/);
});
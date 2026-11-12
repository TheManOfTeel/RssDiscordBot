import { createHash } from 'node:crypto';
import { FeedFormatError, toIsoDate } from './feed.mjs';

const STATUS_URL = 'https://www.apple.com/support/systemstatus/';

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/**
 * Convert Apple's system status payload into the shared feed item shape.
 * Each event revision has its own ID, so incident updates and resolutions are delivered.
 * @param {string} rawText
 * @param {object} [feedConfig]
 * @returns {{format: string, title: string, link: string, items: object[]}}
 */
export function parseAppleStatus(rawText, feedConfig = {}) {
  if (!rawText || !String(rawText).trim()) throw new FeedFormatError('empty response body');

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    throw new FeedFormatError(`not JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.services)) {
    throw new FeedFormatError('expected an Apple system status object with a services array');
  }

  const items = [];
  for (const service of data.services) {
    if (!service || typeof service !== 'object' || typeof service.serviceName !== 'string' || !Array.isArray(service.events)) {
      throw new FeedFormatError('invalid service in Apple system status payload');
    }

    for (const event of service.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new FeedFormatError(`invalid event for ${service.serviceName}`);
      }

      const eventStatus = String(event.eventStatus ?? 'updated');
      const statusType = String(event.statusType ?? 'Status update');
      const message = String(event.message ?? '').trim();
      const affectedServices = Array.isArray(event.affectedServices)
        ? [...new Set(event.affectedServices.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))]
        : [];
      const details = [
        message,
        `Status: ${eventStatus}`,
        event.usersAffected ? `Users affected: ${event.usersAffected}` : '',
        affectedServices.length > 0 ? `Affected services: ${affectedServices.join(', ')}` : '',
      ].filter(Boolean);
      const revision = {
        statusType,
        message,
        datePosted: event.datePosted ?? '',
        startDate: event.startDate ?? '',
        endDate: event.endDate ?? '',
        usersAffected: event.usersAffected ?? '',
        affectedServices,
        eventStatus,
      };
      const identity = event.messageId ?? revision;
      const incidentId = `apple-status-incident:${fingerprint([service.serviceName, identity])}`;
      const id = `apple-status:${fingerprint([service.serviceName, identity, revision])}`;
      const redirectUrl = typeof service.redirectUrl === 'string' && /^https?:\/\//i.test(service.redirectUrl)
        ? service.redirectUrl
        : STATUS_URL;

      items.push({
        id,
        incidentId,
        eventStatus,
        title: `${service.serviceName}: ${statusType} (${eventStatus})`,
        link: redirectUrl,
        summary: details.join('\n'),
        content: details.join('\n'),
        author: service.serviceName,
        categories: [...new Set([statusType, eventStatus])],
        isoDate: toIsoDate(event.datePosted) ?? toIsoDate(event.startDate),
        image: undefined,
      });
    }
  }

  return { format: 'apple-status', title: feedConfig.name ?? 'Apple System Status', link: STATUS_URL, items };
}
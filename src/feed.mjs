/**
 * Feed normalisation: RSS 2.0, RSS 1.0 / RDF, and Atom 1.0 all reduced to one item shape.
 *
 * Normalised item:
 *   { id, title, link, summary, content, author, categories[], isoDate, image }
 *
 * `id` is the dedupe key and is derived defensively — see `deriveId`. Never dedupe on
 * date: feeds routinely emit missing, wrong, or non-monotonic dates.
 */

import { createHash } from 'node:crypto';
import {
  attr,
  childrenNamed,
  findAllDeep,
  firstElement,
  parseXml,
  pick,
  stripHtml,
  textIn,
  textOf,
} from './xml.mjs';

export class FeedFormatError extends Error {}

/**
 * Test whether a string is an HTTP(S) URL.
 *
 * @param {any} value - Value to test
 * @returns {boolean} True if it's a valid http:// or https:// URL
 */
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

/**
 * Convert RFC 822 or ISO 8601 dates to ISO 8601.
 * Rejects absurd values (year < 1990 or > 2200).
 *
 * @param {any} raw - Date string to parse
 * @returns {string|undefined} ISO 8601 string or undefined if invalid
 */
function toIsoDate(raw) {
  if (!raw) return undefined;
  const ms = Date.parse(String(raw).trim());
  if (!Number.isFinite(ms)) return undefined;
  // Reject absurd values: some feeds emit year 0001 or 9999 placeholders.
  const year = new Date(ms).getUTCFullYear();
  if (year < 1990 || year > 2200) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Derive or generate a unique, stable ID for an item.
 * Prefers id candidates over a SHA256 hash of fallback parts.
 *
 * @param {any[]} candidates - Potential ID values (guid, permalink, etc.)
 * @param {string[]} fallbackParts - Content parts to hash if no candidate works
 * @returns {string} Stable ID
 */
function deriveId(candidates, fallbackParts) {
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim();
    if (value) return value;
  }
  return `sha256:${createHash('sha256').update(fallbackParts.join('\u0000')).digest('hex').slice(0, 32)}`;
}

/**
 * Extract link from an Atom entry.
 * Prefers rel="alternate", then a bare <link href>, ignoring enclosures and self.
 *
 * @param {object} entry - Atom entry element
 * @returns {string} Link URL or empty string
 */
function atomLink(entry) {
  const links = childrenNamed(entry, 'link');
  const byRel = (rel) => links.find((l) => (attr(l, 'rel') ?? 'alternate').toLowerCase() === rel && attr(l, 'href'));
  const chosen = byRel('alternate') ?? links.find((l) => attr(l, 'href') && !attr(l, 'rel'));
  return chosen ? attr(chosen, 'href').trim() : '';
}

/**
 * Extract the best image URL from an item.
 * Checks enclosures, Atom enclosure links, and media elements.
 *
 * @param {object} node - Feed item element
 * @returns {string|undefined} Image URL or undefined
 */
function imageOf(node) {
  const enclosure = childrenNamed(node, 'enclosure').find((e) => isHttpUrl(attr(e, 'url')));
  if (enclosure) {
    const type = attr(enclosure, 'type') ?? '';
    if (!type || type.startsWith('image/')) return attr(enclosure, 'url').trim();
  }
  // Atom spells an enclosure <link rel="enclosure" href="..." type="..."> (RFC 4287 §4.2.7),
  // not <enclosure url="...">. Without this, every Atom feed yields no image — Apple's
  // newsroom feed is Atom and attaches its tile image exactly this way. `type` must be
  // present and an image here: unlike RSS, a bare rel="enclosure" is often a video or PDF.
  const atomEnclosure = childrenNamed(node, 'link').find(
    (l) => (attr(l, 'rel') ?? '').toLowerCase() === 'enclosure'
      && (attr(l, 'type') ?? '').toLowerCase().startsWith('image/')
      && isHttpUrl(attr(l, 'href'))
  );
  if (atomEnclosure) return attr(atomEnclosure, 'href').trim();

  // Check media:thumbnail and media:content
  for (const local of ['thumbnail', 'content']) {
    const media = childrenNamed(node, local).find((m) => isHttpUrl(attr(m, 'url')));
    if (media) {
      const medium = (attr(media, 'medium') ?? '').toLowerCase();
      const type = (attr(media, 'type') ?? '').toLowerCase();
      if (local === 'thumbnail' || medium === 'image' || type.startsWith('image/')) {
        return attr(media, 'url').trim();
      }
    }
  }
  return undefined;
}

/**
 * Extract author from an item.
 * Checks dc:creator, <author> (RSS), and <author><name> (Atom).
 *
 * @param {object} node - Feed item element
 * @returns {string|undefined} Author name or undefined
 */
function authorOf(node) {
  // dc:creator (RSS), <author> (RSS email/name), <author><name> (Atom)
  const direct = textIn(node, 'creator');
  if (direct) return direct;
  const author = pick(node, 'author');
  if (!author) return undefined;
  const nested = textIn(author, 'name');
  if (nested) return nested;
  const text = textOf(author).trim();
  return text || undefined;
}

/**
 * Extract categories from an item.
 * Builds a dedup-friendly format: both bare value and "type:value" (if type exists).
 *
 * @param {object} node - Feed item element
 * @returns {string[]} Category array
 */
function categoriesOf(node) {
  const out = [];
  for (const cat of childrenNamed(node, 'category')) {
    const value = (textOf(cat).trim() || attr(cat, 'term') || attr(cat, 'label') || '').trim();
    if (value) out.push(value);
  }
  for (const tag of childrenNamed(node, 'subject')) {
    const value = textOf(tag).trim();
    if (value) out.push(value);
  }
  return [...new Set(out)];
}

function normaliseRssItem(item) {
  const title = textIn(item, 'title');
  const guidNode = pick(item, 'guid', 'identifier');
  const guid = guidNode ? textOf(guidNode).trim() : '';
  const permalinkOk = !guidNode || (attr(guidNode, 'ispermalink') ?? 'true').toLowerCase() !== 'false';

  let link = textIn(item, 'link');
  if (!link) {
    // Some RSS feeds carry only <atom:link href>. Others only a permalink guid.
    const atomish = childrenNamed(item, 'link').find((l) => attr(l, 'href'));
    if (atomish) link = attr(atomish, 'href').trim();
    else if (permalinkOk && isHttpUrl(guid)) link = guid;
  }

  const contentRaw = textIn(item, 'encoded') || textIn(item, 'description') || textIn(item, 'summary');
  const isoDate = toIsoDate(textIn(item, 'pubdate') || textIn(item, 'date') || textIn(item, 'updated'));

  return {
    id: deriveId([guid, link], [title, link, contentRaw.slice(0, 200)]),
    title,
    link: isHttpUrl(link) ? link.trim() : '',
    content: contentRaw,
    summary: stripHtml(contentRaw),
    author: authorOf(item),
    categories: categoriesOf(item),
    isoDate,
    image: imageOf(item),
  };
}

function normaliseAtomEntry(entry) {
  const title = stripHtml(textIn(entry, 'title')) || textIn(entry, 'title');
  const id = textIn(entry, 'id');
  const link = atomLink(entry);
  const contentRaw = textIn(entry, 'content') || textIn(entry, 'summary');
  const isoDate = toIsoDate(textIn(entry, 'published') || textIn(entry, 'updated') || textIn(entry, 'issued'));

  return {
    id: deriveId([id, link], [title, link, contentRaw.slice(0, 200)]),
    title,
    link: isHttpUrl(link) ? link : '',
    content: contentRaw,
    summary: stripHtml(contentRaw),
    author: authorOf(entry),
    categories: categoriesOf(entry),
    isoDate,
    image: imageOf(entry),
  };
}

/**
 * Parse a feed document into { title, link, items[] }.
 * Items are returned in document order (conventionally newest first).
 */
export function parseFeed(xmlText) {
  if (!xmlText || !String(xmlText).trim()) throw new FeedFormatError('empty response body');

  const doc = parseXml(xmlText);
  const root = firstElement(doc);
  if (!root) throw new FeedFormatError('no root element (not XML?)');

  if (root.local === 'feed') {
    let entries = childrenNamed(root, 'entry');
    if (entries.length === 0) entries = findAllDeep(root, 'entry');
    return {
      format: 'atom',
      title: stripHtml(textIn(root, 'title')),
      link: atomLink(root),
      items: entries.map(normaliseAtomEntry),
    };
  }

  if (root.local === 'rss' || root.local === 'rdf' || root.local === 'channel') {
    const channel = root.local === 'channel' ? root : pick(root, 'channel') ?? root;
    // RSS 2.0 nests <item> in <channel>; RSS 1.0 puts it beside it under rdf:RDF.
    let items = childrenNamed(channel, 'item');
    if (items.length === 0) items = childrenNamed(root, 'item');
    if (items.length === 0) items = findAllDeep(root, 'item');
    return {
      format: root.local === 'rdf' ? 'rdf' : 'rss',
      title: textIn(channel, 'title'),
      link: textIn(channel, 'link'),
      items: items.map(normaliseRssItem),
    };
  }

  // Last resort: some servers wrap feeds in an envelope element.
  const items = findAllDeep(root, 'item');
  const entries = findAllDeep(root, 'entry');
  if (items.length > 0 || entries.length > 0) {
    return {
      format: 'unknown',
      title: textIn(root, 'title'),
      link: textIn(root, 'link'),
      items: [...items.map(normaliseRssItem), ...entries.map(normaliseAtomEntry)],
    };
  }

  throw new FeedFormatError(`unrecognised root element <${root.name}>`);
}

export { isHttpUrl, toIsoDate };

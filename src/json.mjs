import { createHash } from 'node:crypto';
import { FeedFormatError, toIsoDate } from './feed.mjs';

/**
 * Read a dotted path from a JSON value, without traversing inherited properties.
 * @param {any} source
 * @param {any} path
 * @returns {any}
 */
function valueAt(source, path) {
    if (typeof path !== 'string' || path.trim() === '') return undefined;
    return path.trim().split('.').reduce((value, key) => {
        if (value == null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        return value[key];
    }, source);
}

/**
 * Resolve a configured field path or interpolate `{path}` placeholders in a template.
 * @param {object} item
 * @param {object} mapping
 * @param {string} field
 * @returns {any}
 */
function mappedValue(item, mapping, field) {
    const path = mapping[field] ?? field;
    if (typeof path !== 'string') return undefined;
    if (!/\{[^{}]+\}/.test(path)) return valueAt(item, path);
    return path.replace(/\{([^{}]+)\}/g, (_match, placeholder) => {
        const value = valueAt(item, placeholder);
        return value == null ? '' : String(value);
    });
}

/** Convert an optional mapped value to text. */
function asText(value) {
    return value == null ? '' : String(value);
}

/** Create a deterministic dedupe key when the source has no usable ID. */
function stableId(item) {
    return `json:${createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 32)}`;
}

/**
 * Parse and normalize a JSON array feed.
 *
 * Parser settings are read from `parserOptions` when present; `rootPath` selects the
 * item array and `mapping` maps normalized fields to dotted paths or templates.
 * @param {string} rawText
 * @param {object} [feedConfig]
 * @returns {{format: string, title: string, link: string, items: object[]}}
 * @throws {FeedFormatError} If the response is invalid JSON or does not contain an item array
 */
export function parseJsonFeed(rawText, feedConfig = {}) {
    if (!rawText || !String(rawText).trim()) throw new FeedFormatError('empty response body');

    let data;
    try {
        data = JSON.parse(rawText);
    } catch (error) {
        throw new FeedFormatError(`not JSON: ${error.message}`);
    }

    const options = feedConfig.parserOptions ?? feedConfig;
    const rawItems = options.rootPath ? valueAt(data, options.rootPath) : data;
    if (!Array.isArray(rawItems)) {
        const path = options.rootPath ? ` at "${options.rootPath}"` : '';
        throw new FeedFormatError(`expected a JSON array${path}`);
    }

    const mapping = options.mapping ?? {};
    const items = rawItems.map((item, index) => {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) {
            throw new FeedFormatError(`item ${index} is not a JSON object`);
        }

        const title = asText(mappedValue(item, mapping, 'title')) || '(untitled)';
        const link = asText(mappedValue(item, mapping, 'link'));
        const summary = asText(mappedValue(item, mapping, 'summary'));
        const content = asText(mappedValue(item, mapping, 'content') ?? summary);
        const idValue = mappedValue(item, mapping, 'id');
        const categoriesValue = mappedValue(item, mapping, 'categories');
        const categories = (Array.isArray(categoriesValue) ? categoriesValue : [categoriesValue])
            .filter((value) => value != null && String(value).trim() !== '')
            .map(String);

        return {
            id: idValue == null || String(idValue) === '' ? stableId(item) : String(idValue),
            title,
            link,
            summary,
            content,
            author: asText(mappedValue(item, mapping, 'author')) || undefined,
            categories: [...new Set(categories)],
            isoDate: toIsoDate(mappedValue(item, mapping, 'isoDate')),
            image: asText(mappedValue(item, mapping, 'image')) || undefined,
        };
    });

    return { format: 'json', title: feedConfig.name ?? '', link: feedConfig.url ?? '', items };
}
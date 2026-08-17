/**
 * Item filtering. Regexes are compiled once at config-load time so a bad pattern fails
 * the run immediately instead of silently matching nothing at 3am.
 */

export class FilterConfigError extends Error {}

const DEFAULT_FIELDS = ['title', 'summary', 'categories'];
const VALID_FIELDS = new Set(['title', 'summary', 'content', 'author', 'categories', 'link', 'id']);

function compileList(patterns, { label, flags }) {
  if (patterns == null) return [];
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.map((pattern) => {
    if (typeof pattern !== 'string') {
      throw new FilterConfigError(`${label}: expected a regex string, got ${typeof pattern}`);
    }
    try {
      return new RegExp(pattern, flags);
    } catch (err) {
      throw new FilterConfigError(`${label}: invalid regex ${JSON.stringify(pattern)} — ${err.message}`);
    }
  });
}

/**
 * @param {object} raw filter block from config
 * @returns {{include: RegExp[], exclude: RegExp[], fields: string[], requireAll: boolean,
 *            maxAgeHours?: number, requireLink: boolean}}
 */
export function compileFilters(raw = {}, label = 'filters') {
  // 'i' so patterns are case-insensitive; 'm' so ^ and $ anchor per line, which is what
  // makes per-category and per-paragraph anchoring work (see `haystack`).
  const flags = typeof raw.flags === 'string' ? raw.flags : 'im';
  try {
    new RegExp('x', flags);
  } catch (err) {
    throw new FilterConfigError(`${label}.flags: invalid regex flags ${JSON.stringify(flags)} — ${err.message}`);
  }

  const fields = raw.fields ?? DEFAULT_FIELDS;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new FilterConfigError(`${label}.fields: expected a non-empty array`);
  }
  for (const field of fields) {
    if (!VALID_FIELDS.has(field)) {
      throw new FilterConfigError(
        `${label}.fields: unknown field ${JSON.stringify(field)} (valid: ${[...VALID_FIELDS].join(', ')})`
      );
    }
  }

  if (raw.maxAgeHours != null && !(Number.isFinite(raw.maxAgeHours) && raw.maxAgeHours > 0)) {
    throw new FilterConfigError(`${label}.maxAgeHours: expected a positive number`);
  }

  return {
    include: compileList(raw.include, { label: `${label}.include`, flags }),
    exclude: compileList(raw.exclude, { label: `${label}.exclude`, flags }),
    fields: [...fields],
    requireAll: raw.requireAll === true,
    maxAgeHours: raw.maxAgeHours ?? undefined,
    requireLink: raw.requireLink !== false,
  };
}

/** Flatten the configured fields of an item into one searchable blob. */
export function haystack(item, fields) {
  const parts = [];
  for (const field of fields) {
    const value = item[field];
    // Newline-separated, not space-separated: with the default `m` flag that makes
    // /^releases$/ match one whole category instead of never matching.
    if (Array.isArray(value)) parts.push(value.join('\n'));
    else if (value != null) parts.push(String(value));
  }
  return parts.join('\n');
}

/**
 * Decide whether an item should be posted.
 * @returns {{pass: boolean, reason?: string}} reason is set only when rejected, for logging.
 */
export function evaluate(item, filters, now = Date.now()) {
  if (filters.requireLink && !item.link) return { pass: false, reason: 'no link' };

  if (filters.maxAgeHours != null) {
    if (!item.isoDate) return { pass: false, reason: 'no date (maxAgeHours set)' };
    const ageHours = (now - Date.parse(item.isoDate)) / 3_600_000;
    if (ageHours > filters.maxAgeHours) return { pass: false, reason: `older than ${filters.maxAgeHours}h` };
  }

  const text = haystack(item, filters.fields);

  // Exclude wins over include, always.
  for (const rx of filters.exclude) {
    rx.lastIndex = 0;
    if (rx.test(text)) return { pass: false, reason: `excluded by /${rx.source}/` };
  }

  if (filters.include.length > 0) {
    const hits = filters.include.filter((rx) => {
      rx.lastIndex = 0;
      return rx.test(text);
    });
    const needed = filters.requireAll ? filters.include.length : 1;
    if (hits.length < needed) {
      return { pass: false, reason: filters.requireAll ? 'missing a required include' : 'no include matched' };
    }
  }

  return { pass: true };
}

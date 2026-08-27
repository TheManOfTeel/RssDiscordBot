/**
 * Config loading and validation.
 *
 * Config is JSON, not YAML, so the bot has zero dependencies — nothing to install, nothing
 * to rot, no supply chain in a job that runs unattended for years. Cost: regexes need
 * JSON backslash escaping ("\\btypescript\\b" is the regex \btypescript\b).
 *
 * Webhook URLs are read from the environment only, never from the config file, so the
 * config can be committed to a public repo.
 *
 * Every problem in the file is reported at once, before a single request is made. A
 * scheduled job must not discover a typo halfway through posting.
 */

import { readFile } from 'node:fs/promises';
import { compileFilters, FilterConfigError } from './filter.mjs';
import { isHttpUrl } from './feed.mjs';
import { safeStateName } from './state.mjs';

export class ConfigError extends Error {}

const DEFAULTS = {
  webhookEnv: 'DISCORD_WEBHOOK',
  maxPerRun: 5,
  seenCap: 500,
  descriptionChars: 400,
  showDescription: true,
  showImage: false,
  showAuthor: true,
  username: undefined,
  avatarUrl: undefined,
  threadId: undefined,
  color: undefined,
  timeoutMs: 20_000,
  parser: 'feed',
};

/**
 * Must stay in sync with the PARSERS table in runner.mjs. Duplicated as a literal rather than
 * imported so config validation has no dependency on the runner — a typo'd parser name is a
 * config error reported alongside the others, before any request is made.
 */
const VALID_PARSERS = new Set(['feed', 'espn-json']);

/** "#5865F2" | "5865F2" | 5793266 -> integer, which is what the embed API wants. */
export function parseColor(value, errors, label) {
  if (value == null) return undefined;
  if (Number.isInteger(value)) return value >= 0 && value <= 0xffffff ? value : (errors.push(`${label}: color out of range`), undefined);
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return Number.parseInt(hex, 16);
  }
  errors.push(`${label}: color must be "#rrggbb" or an integer`);
  return undefined;
}

/** Discord snowflake: 17–20 digits. Must be a JSON string — 19 digits exceeds 2^53. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The all-zeros id used as a placeholder in the shipped config. Syntactically a snowflake,
 * so it loads — but it is not a real role, and Discord renders it as a dead mention. Warn
 * rather than error: an unedited config must still be runnable with --dry-run.
 */
const PLACEHOLDER_ID = /^0+$/;

/**
 * Compile `notify` rules: which roles/users to ping, and on which items.
 *
 * A rule with no `when` block pings on every item of the feed. A rule with one reuses the
 * whole filter language, so ping conditions and delivery conditions behave identically.
 */
export function compileNotify(rawNotify, label, errors, warnings = []) {
  if (rawNotify == null) return [];
  if (!Array.isArray(rawNotify)) {
    errors.push(`${label}: expected an array of rules`);
    return [];
  }

  const rules = [];
  rawNotify.forEach((rule, index) => {
    const at = `${label}[${index}]`;
    if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${at}: must be an object`);
      return;
    }

    const roles = rule.roles ?? [];
    const users = rule.users ?? [];
    if (!Array.isArray(roles) || !Array.isArray(users)) {
      errors.push(`${at}: "roles" and "users" must be arrays of id strings`);
      return;
    }
    if (roles.length === 0 && users.length === 0) {
      errors.push(`${at}: needs at least one entry in "roles" or "users"`);
    }
    for (const id of [...roles, ...users]) {
      if (typeof id !== 'string' || !SNOWFLAKE.test(id)) {
        errors.push(
          `${at}: ${JSON.stringify(id)} is not a Discord id — it must be a 17-20 digit ` +
            `STRING (Discord → User Settings → Advanced → Developer Mode, then right-click the role → Copy Role ID)`
        );
      } else if (PLACEHOLDER_ID.test(id)) {
        warnings.push(
          `${at}: ${JSON.stringify(id)} is the placeholder id, not a real one. Items matching this rule will ` +
            `post a dead mention and will not ping anyone. Replace it with a real id, or delete the "notify" block.`
        );
      }
    }
    if (rule.text != null && typeof rule.text !== 'string') errors.push(`${at}.text: must be a string`);

    let when = null;
    if (rule.when != null) {
      try {
        // requireLink defaults false here: the item already cleared the feed's own filters,
        // so a ping rule should not silently re-litigate that.
        when = compileFilters({ requireLink: false, ...rule.when }, `${at}.when`);
      } catch (err) {
        if (err instanceof FilterConfigError) errors.push(err.message);
        else throw err;
      }
    }

    rules.push({ roles: [...roles], users: [...users], text: rule.text ?? undefined, when });
  });
  return rules;
}

function positiveInt(value, label, errors, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${label}: expected an integer between ${min} and ${max}, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  if (!Array.isArray(raw.feeds)) throw new ConfigError('config.feeds must be an array');
  if (raw.feeds.length === 0) throw new ConfigError('config.feeds is empty — nothing to poll');

  const rawDefaults = raw.defaults ?? {};
  const defaults = { ...DEFAULTS, ...rawDefaults };
  defaults.color = parseColor(rawDefaults.color, errors, 'defaults.color');

  // A filter block on `defaults` applies to every feed IN ADDITION to that feed's own
  // block (both must pass) — that is how you express a global blocklist.
  let globalFilters;
  try {
    globalFilters = rawDefaults.filters ? compileFilters(rawDefaults.filters, 'defaults.filters') : undefined;
  } catch (err) {
    if (err instanceof FilterConfigError) errors.push(err.message);
    else throw err;
  }

  const globalNotify = compileNotify(rawDefaults.notify, 'defaults.notify', errors, warnings);

  const ids = new Set();
  const stateNames = new Map();
  const feeds = [];

  raw.feeds.forEach((feed, index) => {
    const label = `feeds[${index}]`;
    if (feed == null || typeof feed !== 'object') {
      errors.push(`${label}: must be an object`);
      return;
    }
    if (feed.enabled === false) return;

    if (typeof feed.id !== 'string' || feed.id.trim() === '') errors.push(`${label}.id: required, non-empty string`);
    else {
      try {
        // Two different ids that sanitise to the same filename would silently share one
        // state file, and each run would treat the other feed's items as already seen.
        const stateName = safeStateName(feed.id);
        const owner = stateNames.get(stateName);
        if (owner != null && owner !== feed.id) {
          errors.push(`${label}.id: ${JSON.stringify(feed.id)} and ${JSON.stringify(owner)} both map to the state file ${stateName}.json`);
        }
        stateNames.set(stateName, feed.id);
      } catch (err) {
        errors.push(`${label}.id: ${err.message}`);
      }
      if (ids.has(feed.id)) errors.push(`${label}.id: duplicate id ${JSON.stringify(feed.id)} — ids key the state files`);
      ids.add(feed.id);
    }

    if (!isHttpUrl(feed.url)) errors.push(`${label}.url: required, must start with http:// or https://`);

    const webhookEnv = feed.webhookEnv ?? defaults.webhookEnv;
    if (typeof webhookEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(webhookEnv)) {
      errors.push(`${label}.webhookEnv: must be a valid environment variable name`);
    }
    if ('webhook' in feed || 'webhookUrl' in feed) {
      errors.push(`${label}: put the webhook URL in an environment variable / repo secret and name it via "webhookEnv" — never in this file`);
    }

    const parser = feed.parser ?? defaults.parser;
    if (!VALID_PARSERS.has(parser)) {
      errors.push(`${label}.parser: unknown parser ${JSON.stringify(parser)} (valid: ${[...VALID_PARSERS].join(', ')})`);
    }
    if (feed.parserOptions != null && (typeof feed.parserOptions !== 'object' || Array.isArray(feed.parserOptions))) {
      errors.push(`${label}.parserOptions: must be an object`);
    }

    let filters;
    try {
      filters = compileFilters(feed.filters ?? {}, `${label}.filters`);
    } catch (err) {
      if (err instanceof FilterConfigError) errors.push(err.message);
      else throw err;
    }

    feeds.push({
      id: feed.id,
      name: feed.name ?? feed.id,
      url: typeof feed.url === 'string' ? feed.url.trim() : feed.url,
      webhookEnv,
      maxPerRun: positiveInt(feed.maxPerRun ?? defaults.maxPerRun, `${label}.maxPerRun`, errors, { max: 200 }),
      seenCap: positiveInt(feed.seenCap ?? defaults.seenCap, `${label}.seenCap`, errors, { min: 10, max: 20_000 }),
      descriptionChars: positiveInt(feed.descriptionChars ?? defaults.descriptionChars, `${label}.descriptionChars`, errors, { min: 0, max: 4096 }),
      showDescription: (feed.showDescription ?? defaults.showDescription) !== false,
      showImage: (feed.showImage ?? defaults.showImage) === true,
      showAuthor: (feed.showAuthor ?? defaults.showAuthor) !== false,
      username: feed.username ?? defaults.username,
      avatarUrl: feed.avatarUrl ?? defaults.avatarUrl,
      threadId: feed.threadId ?? defaults.threadId,
      timeoutMs: feed.timeoutMs ?? defaults.timeoutMs,
      parser,
      parserOptions: feed.parserOptions ?? {},
      color: 'color' in feed ? parseColor(feed.color, errors, `${label}.color`) : defaults.color,
      filterChain: [globalFilters, filters].filter(Boolean),
      notify: [...globalNotify, ...compileNotify(feed.notify, `${label}.notify`, errors, warnings)],
    });
  });

  if (feeds.length === 0 && errors.length === 0) throw new ConfigError('every feed is disabled — nothing to poll');
  if (errors.length > 0) throw new ConfigError(`invalid config:\n  - ${errors.join('\n  - ')}`);

  return { feeds, warnings };
}

export async function loadConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConfigError(`config file not found: ${file}`);
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON — ${err.message}`);
  }
  return validateConfig(parsed);
}

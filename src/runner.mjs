#!/usr/bin/env node
/**
 * Poll every configured feed once, post whatever is new and passes its filters, persist state.
 *
 * Designed for a scheduled GitHub Actions run, so:
 *   - one feed failing never aborts the others (each is isolated; exit code reflects the worst case)
 *   - state is written even on failure, so successful posts are never re-sent
 *   - items already delivered are recorded per chunk, so a mid-run crash re-sends at most 10
 *   - the first run for a feed SEEDS state and posts nothing, instead of dumping 50 items
 */

import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { allowedMentionsFor, clip, mentionContent, postEmbeds } from './discord.mjs';
import { parseFeed } from './feed.mjs';
import { fetchFeed } from './http.mjs';
import { evaluate } from './filter.mjs';
import { DEFAULT_SEEN_CAP, loadState, mergeSeen, saveState } from './state.mjs';

const CHUNK = 10; // embeds per Discord message
const DRY_RUN_WEBHOOK = 'https://discord.com/api/webhooks/0/dry-run-no-secret-needed';

export function parseArgs(argv) {
  const options = {
    config: 'feeds.json',
    stateDir: 'state',
    only: null,
    dryRun: false,
    seed: false,
    force: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next == null) throw new Error(`${arg} requires a value`);
      return next;
    };
    switch (arg) {
      case '--config': case '-c': options.config = value(); break;
      case '--state-dir': options.stateDir = value(); break;
      case '--only': options.only = value().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--dry-run': case '-n': options.dryRun = true; break;
      case '--seed': options.seed = true; break;
      case '--force': options.force = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--') && arg.includes('=')) {
          const [flag, ...rest] = arg.split('=');
          argv.splice(i + 1, 0, rest.join('='));
          argv[i] = flag;
          i--;
          break;
        }
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const HELP = `rss-discord-bot

  node src/runner.mjs [options]

  -c, --config <file>   feed config          (default: feeds.json)
      --state-dir <dir> state directory      (default: state)
      --only <ids>      comma-separated feed ids to poll
  -n, --dry-run         fetch + filter + render, but POST nothing and write no state
      --seed            treat every feed as first-run: record ids, post nothing
      --force           ignore stored ETag/Last-Modified (re-download unconditionally)
  -v, --verbose         log each item and why it was dropped
  -h, --help            this text

  The webhook URL comes from the environment variable named by "webhookEnv"
  (default DISCORD_WEBHOOK). It is never read from the config file.`;

function buildEmbed(item, feed) {
  return {
    title: item.title || '(untitled)',
    url: item.link || undefined,
    description: feed.showDescription && feed.descriptionChars > 0 ? clip(item.summary, feed.descriptionChars) : undefined,
    timestamp: item.isoDate,
    color: feed.color,
    author: feed.showAuthor && item.author ? { name: item.author } : undefined,
    footer: { text: feed.name },
    image: feed.showImage && item.image ? { url: item.image } : undefined,
  };
}

/** Union of every notify rule this item satisfies, or null if it should arrive silently. */
export function mentionsFor(item, notify, now) {
  const roles = new Set();
  const users = new Set();
  const texts = [];
  for (const rule of notify) {
    if (rule.when && !evaluate(item, rule.when, now).pass) continue;
    for (const id of rule.roles) roles.add(id);
    for (const id of rule.users) users.add(id);
    if (rule.text) texts.push(rule.text);
  }
  if (roles.size === 0 && users.size === 0) return null;
  return { roles: [...roles], users: [...users], text: texts[0] };
}

/**
 * Identity of a mention set, for deciding what may share a message. Ids are sorted so two
 * rules that union to the same targets in a different order still collapse.
 */
const mentionKey = (mention) =>
  mention === null ? '' : JSON.stringify([[...mention.roles].sort(), [...mention.users].sort(), mention.text ?? '']);

/**
 * Split the queue into messages, batching RUNS OF ITEMS THAT SHARE A MENTION SET (up to the
 * 10-embed limit). Consecutive items that all ping the same role travel as one message with
 * one mention, so an 8-platform beta drop is one notification rather than eight.
 *
 * The grouping is by identical mention, not merely "pings something": a role must never be
 * pinged for a message whose other embeds don't concern it. So an item pinging @ios-betas
 * cannot share with one pinging @mac-betas, and neither can share with a silent item.
 * Order is preserved throughout.
 */
export function groupForDelivery(queue, notify, now, chunk = CHUNK) {
  const groups = [];
  let buffer = [];
  let bufferKey = null;
  let bufferMention = null;
  const flush = () => {
    if (buffer.length > 0) groups.push({ items: buffer, mention: bufferMention });
    buffer = [];
    bufferKey = null;
    bufferMention = null;
  };
  for (const item of queue) {
    const mention = notify.length > 0 ? mentionsFor(item, notify, now) : null;
    const key = mentionKey(mention);
    if (buffer.length > 0 && key !== bufferKey) flush();
    bufferKey = key;
    bufferMention = mention;
    buffer.push(item);
    if (buffer.length >= chunk) flush();
  }
  flush();
  return groups;
}

/** Oldest first, so the channel reads chronologically. Undated feeds are assumed newest-first. */
function chronological(items) {
  const dated = items.filter((i) => i.isoDate);
  if (dated.length === items.length) {
    return [...items].sort((a, b) => Date.parse(a.isoDate) - Date.parse(b.isoDate));
  }
  return [...items].reverse();
}

async function runFeed(feed, options, log) {
  const result = { id: feed.id, status: 'ok', fetched: 0, fresh: 0, filtered: 0, posted: 0, pinged: 0, skipped: 0, note: '' };
  const state = await loadState(options.stateDir, feed.id);
  if (state.corruptedAt) log(`  ! state file was unreadable and has been reset`);

  const postedIds = [];
  let currentIds = [];
  let failure;

  try {
    const response = await fetchFeed(feed.url, {
      etag: options.force ? undefined : state.etag,
      lastModified: options.force ? undefined : state.lastModified,
      timeoutMs: feed.timeoutMs,
      log,
    });

    if (response.notModified) {
      result.status = 'not-modified';
      result.note = '304';
      log(`  304 not modified`);
    } else {
      const parsed = parseFeed(response.body);
      state.etag = response.etag ?? null;
      state.lastModified = response.lastModified ?? null;
      result.fetched = parsed.items.length;
      currentIds = parsed.items.map((i) => i.id);
      log(`  ${parsed.format}: ${parsed.items.length} item(s)`);

      const seen = new Set(state.seen);
      const fresh = parsed.items.filter((item) => !seen.has(item.id));
      result.fresh = fresh.length;

      if (!state.initialized || options.seed) {
        result.status = 'seeded';
        result.note = `seeded ${currentIds.length} id(s), posted nothing`;
        log(`  first run: ${result.note}`);
      } else {
        const now = Date.now();
        const passing = [];
        for (const item of fresh) {
          // Every block in the chain must pass: defaults.filters (global) then feeds[].filters.
          let verdict = { pass: true };
          for (const filters of feed.filterChain) {
            verdict = evaluate(item, filters, now);
            if (!verdict.pass) break;
          }
          if (verdict.pass) passing.push(item);
          else if (options.verbose) log(`    drop: ${verdict.reason} — ${item.title?.slice(0, 70)}`);
        }
        result.filtered = fresh.length - passing.length;

        let queue = chronological(passing);
        if (queue.length > feed.maxPerRun) {
          // Keep the newest maxPerRun; the rest are marked seen and never posted. Say so —
          // a silent cap looks identical to "nothing was new".
          result.skipped = queue.length - feed.maxPerRun;
          log(`  ! ${result.skipped} item(s) over maxPerRun=${feed.maxPerRun} will be skipped (marked as seen, not posted)`);
          queue = queue.slice(-feed.maxPerRun);
        }

        const webhook = process.env[feed.webhookEnv];
        if (!webhook && queue.length > 0 && !options.dryRun) {
          throw new Error(`environment variable ${feed.webhookEnv} is not set`);
        }

        // One postEmbeds call per group so `postedIds` is only credited after a message
        // actually lands. A crash mid-run therefore re-sends at most one group.
        for (const group of groupForDelivery(queue, feed.notify, now)) {
          await postEmbeds(webhook ?? DRY_RUN_WEBHOOK, group.items.map((item) => buildEmbed(item, feed)), {
            content: group.mention ? mentionContent(group.mention) : undefined,
            allowedMentions: group.mention ? allowedMentionsFor(group.mention) : undefined,
            username: feed.username,
            avatarUrl: feed.avatarUrl,
            threadId: feed.threadId,
            dryRun: options.dryRun,
            log,
          });
          if (group.mention) result.pinged += group.items.length;
          for (const item of group.items) {
            postedIds.push(item.id);
            log(`  ${group.mention ? '🔔' : '→'} ${item.title?.slice(0, 90) ?? item.id}`);
          }
        }
        result.posted = postedIds.length;
      }
    }
  } catch (err) {
    failure = err;
    result.status = 'error';
    result.note = err.message;
  }

  if (!options.dryRun) {
    state.lastRun = new Date().toISOString();
    if (failure) {
      // Only what actually landed becomes seen; everything else retries next run.
      state.seen = mergeSeen(postedIds, state.seen, feed.seenCap ?? DEFAULT_SEEN_CAP);
      if (postedIds.length > 0) state.initialized = true;
    } else {
      state.seen = mergeSeen(currentIds.length > 0 ? currentIds : postedIds, state.seen, feed.seenCap ?? DEFAULT_SEEN_CAP);
      state.initialized = true;
      state.lastSuccess = state.lastRun;
      delete state.corruptedAt;
    }
    await saveState(options.stateDir, feed.id, state);
  }

  if (failure) log(`  ✗ ${failure.message}`);
  return result;
}

async function writeGithubSummary(results) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  const githubEventName = process.env.GITHUB_EVENT_NAME;
  if (!file) return;
  // Keep PR validation runs focused on tests; the feed summary is operational noise there.
  if (githubEventName === 'pull_request' || githubEventName === 'pull_request_target' || process.env.GITHUB_HEAD_REF) return;
  const rows = results.map(
    (r) => `| ${r.id} | ${r.status} | ${r.fetched} | ${r.fresh} | ${r.filtered} | ${r.posted} | ${r.pinged} | ${r.skipped} | ${r.note.replace(/\|/g, '\\|').slice(0, 160)} |`
  );
  const body = [
    '### RSS → Discord',
    '',
    '| feed | status | items | new | filtered | posted | pinged | skipped | note |',
    '| --- | --- | --: | --: | --: | --: | --: | --: | --- |',
    ...rows,
    '',
  ].join('\n');
  await appendFile(file, `${body}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const config = await loadConfig(path.resolve(options.config));

  // Config problems that shouldn't stop the run but must not be silent either. In Actions,
  // ::warning:: puts them on the run summary instead of burying them in the log.
  for (const warning of config.warnings ?? []) {
    console.error(process.env.GITHUB_ACTIONS ? `::warning::${warning}` : `warning: ${warning}`);
  }

  const feeds = options.only ? config.feeds.filter((f) => options.only.includes(f.id)) : config.feeds;

  if (feeds.length === 0) {
    console.error(`no feeds matched --only ${options.only?.join(',')}`);
    return 2;
  }

  console.log(`${options.dryRun ? '[dry-run] ' : ''}polling ${feeds.length} feed(s)`);
  const results = [];
  // Sequential on purpose: N feeds hitting one webhook in parallel just earns 429s, and a
  // 10-feed run still finishes in a couple of seconds.
  for (const feed of feeds) {
    console.log(`\n${feed.name} <${feed.url}>`);
    results.push(await runFeed(feed, options, (line) => console.log(line)));
  }

  const posted = results.reduce((sum, r) => sum + r.posted, 0);
  const pinged = results.reduce((sum, r) => sum + r.pinged, 0);
  const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const failed = results.filter((r) => r.status === 'error');
  console.log(
    `\ndone: ${posted} posted (${pinged} with a ping), ${skipped} skipped by maxPerRun, ${failed.length} feed(s) failed` +
      (failed.length > 0 ? ` (${failed.map((f) => f.id).join(', ')})` : '')
  );

  await writeGithubSummary(results).catch((err) => console.error(`could not write job summary: ${err.message}`));
  return failed.length > 0 ? 1 : 0;
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntrypoint) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? String(err));
      process.exit(1);
    }
  );
}

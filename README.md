# rss-discord-bot

RSS/Atom → Discord webhook relay with regex filtering. Runs on GitHub Actions cron. Zero
dependencies, zero servers, zero cost on a public repo.

```
feeds.json  ──┐
              ├─► Actions cron ─► conditional GET ─► parse ─► dedupe ─► filter ─► webhook
state/*.json ─┘                                                                    │
     ▲                                                                             │
     └───────────────────── committed back to the repo ◄────────────────────────────┘
```

## Why not GitHub Pages

Pages is static hosting: no server-side execution, no scheduler, and no way to keep a
secret. Actions is the free primitive that gives you all three — a periodic compute slot,
encrypted secrets, and a place to persist state. Pages can still host a static editor that
*emits* a `feeds.json` for you to commit, but it can never run the poll.

## Setup

1. Push this directory to its own repo. **Make it public** unless you need it private — see
   [Cost](#cost) below.

   ```bash
   git init && git add . && git commit -m 'feat: rss to discord relay'
   ```

2. In Discord: **Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy
   Webhook URL.** You need Manage Webhooks on that channel. The webhook is bound to one
   channel, so create one per target channel.

3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**,
   named to match the feed's `webhookEnv`, value = that URL. The shipped config expects
   four, one per target channel:

   | Secret | Channel | Feed |
   | --- | --- | --- |
   | `DISCORD_WEBHOOK_APPLE_NEWSROOM` | `#apple-newsroom` | `apple-newsroom` |
   | `DISCORD_WEBHOOK_APPLE_DEV_NEWS` | `#apple-dev-news` | `apple-dev-news` |
   | `DISCORD_WEBHOOK_APPLE_RELEASES` | `#apple-releases` | `apple-releases` |
   | `DISCORD_WEBHOOK_APPLE_RELEASES_BETA` | `#apple-releases-beta` | `apple-releases-beta` |

   `DISCORD_WEBHOOK` is only the fallback for feeds that don't name their own.

   Every `webhookEnv` in `feeds.json` must also be listed in the `env:` block of
   [.github/workflows/rss-to-discord.yml](.github/workflows/rss-to-discord.yml) — Actions
   does not inject secrets automatically.

4. Give the state commit an identity that can push. The workflow mints a GitHub App
   installation token rather than using `GITHUB_TOKEN`, because `github-actions[bot]` cannot be
   named in a branch ruleset's bypass list and an App can.

   **Settings → Developer settings → GitHub Apps → New GitHub App**: any name (globally
   unique), Homepage URL = this repo, **Webhook → Active unchecked**, Repository permissions
   → **Contents: Read and write**, and nothing else. Then **Generate a private key**,
   **Install App** on this repo only, and add two more secrets:

   | Secret | Value |
   | --- | --- |
   | `BOT_APP_ID` | the App ID from the App's General page |
   | `BOT_PRIVATE_KEY` | the entire downloaded `.pem`, BEGIN/END lines included |

   `permissions: contents: read` in the workflow is deliberate — the push uses the App token,
   so the repo-level **Settings → Actions → General → Workflow permissions** can stay
   read-only.

5. Edit [feeds.json](feeds.json), then check it locally before pushing:

   ```bash
   node src/runner.mjs --dry-run --verbose
   ```

6. Seed the cursors so the first real run doesn't dump every feed's backlog:

   ```bash
   node src/runner.mjs --seed
   ```

   No webhook needed: `--seed` records ids and posts nothing.

   Commit the resulting `state/*.json`. (A feed with no state file seeds itself on its
   first run and posts nothing, so this step is optional — it just moves the no-op run to
   your machine.)

7. Trigger it once by hand: **Actions → rss-to-discord → Run workflow.**

## Configuration

`feeds.json`. It is JSON rather than YAML so the project has no dependencies — the cost is
that regexes need JSON backslash escaping: `"\\btypescript\\b"` is the regex
`\btypescript\b`.

```jsonc
{
  "defaults": {                      // every key here can be overridden per feed
    "webhookEnv": "DISCORD_WEBHOOK", // env var NAME, never a URL
    "maxPerRun": 5,
    "seenCap": 500,
    "descriptionChars": 400,
    "filters": { "exclude": ["\\bsponsored\\b"] }  // global: applied to every feed too
  },
  "feeds": [
    {
      "id": "apple-newsroom",        // keys state/apple-newsroom.json — renaming it re-seeds
      "name": "Apple Newsroom",      // embed footer text
      "url": "https://www.apple.com/ca/newsroom/rss-feed.rss",
      "webhookEnv": "DISCORD_WEBHOOK_APPLE_NEWSROOM",
      "color": "#333333",
      "enabled": true,
      "maxPerRun": 5,
      "filters": {                   // which items get POSTED at all
        "fields": ["title", "summary", "categories"],
        "include": ["\\btypescript\\b", "\\bpostgres(ql)?\\b"],
        "exclude": ["\\b(crypto|nft)\\b"],
        "maxAgeHours": 48
      },
      "notify": [                    // which posted items also PING someone
        {
          "roles": ["987654321098765432"],
          "text": "New hardware:",
          "when": { "fields": ["title"], "include": ["\\biphone\\b"] }
        }
      ]
    }
  ]
}
```

`filters` decide what gets posted. `notify` decides which of those posts ping — it never
adds or removes items.

### Filter semantics

| Key | Meaning |
| --- | --- |
| `fields` | Which item fields to search: `title`, `summary`, `content`, `author`, `categories`, `link`, `id`. Default `["title","summary","categories"]`. |
| `include` | Array of regexes. **Any** match passes. Empty/absent = everything passes. |
| `exclude` | Array of regexes. **Any** match rejects. Always beats `include`. |
| `requireAll` | `true` turns `include` into AND. |
| `flags` | Regex flags, default `"im"` — case-insensitive, and `^`/`$` anchor per line. |
| `maxAgeHours` | Reject items older than this. Also rejects undated items. |
| `requireLink` | Default `true`; items with no usable URL are dropped. |

`defaults.filters` and a feed's own `filters` are two independent blocks and **both** must
pass — that is how you express a global blocklist plus per-feed rules.

Because `fields` are joined one-value-per-line and `m` is on by default, `"^releases$"`
against `categories` matches the whole category `releases` and not `release candidate`.

Every regex is compiled when the config loads, so a typo fails the run immediately instead
of silently matching nothing at 03:00.

### Splitting one feed into two streams

Apple publishes public releases and betas on the *same* URL. The shipped config reads it
twice with complementary filters, which is how one upstream feed becomes two streams in two
different channels:

| Feed id | Filter | Channel | Colour |
| --- | --- | --- | --- |
| `apple-releases` | `exclude` the pre-release words | `#apple-releases` | green `#34c759` |
| `apple-releases-beta` | `include` the same words | `#apple-releases-beta` | amber `#ff9f0a` |

The words are `beta`/`betas`, `release candidate`, `rc`, `preview`, `seed`.

Why two feed entries rather than one:

- `webhookEnv` is per-feed, so routing the two halves to different channels *requires* two
  entries. Same for `color`, `username`, footer `name` and `maxPerRun`.
- Each id gets its own `state/<id>.json`, so the two streams dedupe independently.
- Each gets its own `notify` rules — ping on public releases, stay quiet on betas.

The two blocks must be **exact complements** or the split leaks: a gap silently drops a
release, an overlap posts it twice. `test/releases.test.mjs` asserts every sample title
lands in exactly one stream — extend that list rather than editing the regexes blind.

They match on `fields: ["title"]` only, deliberately: a public release's body routinely
says "changes since beta 4", and matching the body would file it as a beta.

Cost of reading one URL twice: one extra conditional GET per run. Both requests send
`If-None-Match`, so the usual case is two 304s.

### Role pings (`notify`)

`notify` is an array of rules. A rule fires when its `when` block matches a posted item,
and the item is then delivered with a real mention in the message.

| Key | Meaning |
| --- | --- |
| `roles` | Array of role ids, as **JSON strings**. Rendered `<@&id>`. |
| `users` | Array of user ids, as **JSON strings**. Rendered `<@id>`. |
| `text` | Optional lead-in before the mentions, e.g. `"New hardware:"`. |
| `when` | A filter block, same keys as [Filter semantics](#filter-semantics). Omit it and the rule pings on **every** item. `requireLink` defaults to `false` here. |

Ids must be quoted strings. A 19-digit Discord snowflake exceeds `2^53` and an unquoted
JSON number silently loses precision, so a bare number is a config error rather than a
mystery non-ping. Get one with **User Settings → Advanced → Developer Mode**, then
right-click the role in **Server Settings → Roles → Copy Role ID**.

The shipped config uses `"000000000000000000"` as a placeholder so it stays loadable before
you edit it. That id is a valid snowflake but not a real role, so the run **warns** about it
(as a `::warning::` annotation under Actions) and Discord would render a dead mention.
Replace it or delete the `notify` block before the first live run.

Behaviour worth knowing:

- **A mention inside an embed is inert.** Discord only resolves mentions in the top-level
  `content`, so the ping goes there and the embed carries the article.
- **Batching is grouped by identical mention set.** A run of consecutive items that all ping
  the same targets travels as **one** message with **one** mention (up to the 10-embed cap),
  so an always-ping rule on a 7-platform beta drop is one notification, not seven. Items
  with *different* mention sets never share a message, and a pinged item never shares with a
  silent one — a role must not be pinged for a message whose other embeds don't concern it.
- Every message sends `allowed_mentions`. The default is `{"parse":[]}`, which blocks
  everything — including an `@everyone` that appears in feed text. A matching rule adds
  only the specific ids to a `roles`/`users` allowlist, so a feed can never ping anything
  you did not name.
- Overlapping rules **union** their targets and dedupe. The first matching rule's `text`
  wins.
- `defaults.notify` is additive, not overridden: a feed's own rules run in addition to it.
- If a batch has to be split for Discord's 6,000-character limit, only the first message
  carries the mention. A split forced by the **10-embed** cap is different: those are separate
  groups, so 12 same-mention items arrive as two messages that *each* ping. Only reachable
  when one poll yields more than 10 pinged items.
- 🟡 If the role isn't pingable by non-privileged members you may need **Server Settings →
  Roles → *role* → Allow anyone to @mention this role**. Webhooks are generally exempt from
  the mentionable flag, but this is the first thing to check if the message renders the
  mention as plain text.

### Other per-feed keys

| Key | Default | Notes |
| --- | --- | --- |
| `maxPerRun` | `5` | Cap per run. Overflow is marked seen and **never posted** — the run logs how many. |
| `seenCap` | `500` | Ids remembered. Never evicts an id still present in the feed. |
| `descriptionChars` | `400` | `0` omits the description entirely. |
| `showImage` | `false` | Use the item's enclosure/`media:*` image as the embed image. |
| `showAuthor` | `true` | |
| `username` / `avatarUrl` | — | Override the webhook's display name/avatar. |
| `threadId` | — | Post into a thread instead of the channel. |
| `webhookEnv` | `DISCORD_WEBHOOK` | Different channels = different secrets. |
| `notify` | `[]` | Role/user ping rules — see [Role pings](#role-pings-notify). |
| `timeoutMs` | `20000` | |

Putting a `webhook` or `webhookUrl` key in this file is a hard config error. Webhook URLs
are credentials: anyone holding one can post to your channel as you.

## CLI

```bash
node src/runner.mjs [--config feeds.json] [--state-dir state] [--only id1,id2]
                    [--dry-run] [--seed] [--force] [--verbose]
```

- `--dry-run` — fetch, filter, render; POST nothing, write no state, no secret needed.
- `--seed` — record current ids as seen, post nothing. Use after adding a feed or widening
  a filter, so you don't flood the channel.
- `--force` — ignore the stored ETag/Last-Modified.
- `--only` — restrict to specific feed ids.

Exit codes: `0` clean, `1` at least one feed failed, `2` bad arguments/config.

```bash
npm test
```

82 tests, `node:test`, no network. Covers the XML parser's malformed-input recovery, all
three feed formats, filter semantics, Discord limit/rate-limit handling, state trimming,
and an end-to-end run with a stubbed `fetch`.

## Cost

| | |
| --- | --- |
| Public repo, standard runners | Free, unmetered |
| Private repo, Free plan | 2,000 min/month, **shared across every private repo on the account** |
| Private repo, Pro | 3,000 min/month |

Actions bills each job **rounded up to the nearest minute**, so a 25-second poll costs a
full minute. Linux is the 1× multiplier (Windows 2×, macOS 10×), and this runs on
`ubuntu-latest`.

| cron | runs/month | billed min/month | % of the 2,000 free tier |
| --- | --: | --: | --: |
| `7,22,37,52 * * * *` (15 min) | ~2,920 | ~2,920 | 146% — over |
| flat `7,37 * * * *` (30 min) | ~1,460 | ~1,460 | 73% |
| **shipped: weighted (see the workflow)** | **~690** | **~690** | **35%** |
| flat `7 * * * *` (hourly) | ~730 | ~730 | 37% |
| flat `7 */2 * * *` (2 hours) | ~365 | ~365 | 18% |

The shipped schedule is three non-overlapping cron entries rather than one: every 30 minutes
during Cupertino business hours on weekdays, every 2 hours otherwise. That buys the same
30-minute latency in the window where Apple actually publishes, at slightly *less* than the
cost of flat hourly polling. Replace all three with a single `- cron: '7,37 * * * *'` if you
want uniform 30-minute polling and have the minutes to spare.

Note what dominates: ~690 billed minutes for maybe 5 minutes of real work. The cost here is
almost entirely the per-job rounding, so **run count is the only lever that matters** — the
number of feeds barely moves it.

Those figures assume each run finishes inside one minute, which it does when the feeds
respond: 5 conditional GETs, ~20–35s wall clock including checkout and the state commit.
The failure mode that breaks the arithmetic is a feed that hangs — `fetchFeed` retries twice
with 1s/2s backoff behind a 20s timeout, so one unreachable URL costs ~63s, and all five
unreachable costs ~5min. `timeout-minutes: 10` is the hard ceiling. A month of that would
bill ~8,700 minutes, 4× the Free pool. The 540 spare minutes absorb roughly a third of runs
overrunning into a second minute, which covers the realistic case.

Running out does not produce a surprise bill: the default Actions spending limit is $0, so
once the pool is gone the scheduled runs simply stop until the billing cycle resets. Overage,
if you deliberately raise the limit, is $0.008/min on Linux.

## Operational notes, in rough order of how much they will surprise you

1. **Cron is best-effort.** GitHub delays scheduled runs under load — routinely 5–20
   minutes — and may drop them entirely. The schedule here deliberately avoids `:00`, the
   most congested slot. This bot is eventually-consistent; it is not punctual. The minimum
   supported interval is 5 minutes.
2. **60 days of repo inactivity disables the schedule.** GitHub emails you and stops
   running it. Committing state on every run counts as activity, which is a second reason
   the cursors live in the repo rather than in `actions/cache`.
3. **Renaming a feed's `id` orphans its state file** and the feed re-seeds (posting
   nothing) on the next run. Delete the orphan by hand.
4. **Widening a filter does not backfill.** Items already in `seen` are never reconsidered,
   including ones that were filtered out. That is deliberate — otherwise loosening a regex
   would dump months of history into the channel. To backfill, delete the feed's state file.
5. **`maxPerRun` overflow is dropped, not queued.** The newest N are posted, the rest are
   marked seen. The run log and the job summary both report the count.
6. **A push protection or branch protection rule that blocks the bot** will make the state
   commit fail, and every run will re-post the same items. The job fails loudly rather than
   silently, but check it after enabling any protection rule.

## Design decisions worth knowing

- **Dedupe on `guid`/`id`, never on date.** Feeds emit missing, wrong, and non-monotonic
  dates constantly. Fallback chain: `guid` → `id` → `link` → SHA-256 of title+link+content.
- **Conditional GET.** ETag/`If-Modified-Since` are stored per feed; a 304 costs no
  transfer, no parse, and no Actions time. Polite bots don't get blocked.
- **First run seeds.** A cold start records ids and posts nothing, instead of dumping 50
  items into the channel.
- **`allowed_mentions: {parse: []}` on every message.** Feed content is untrusted input; an
  item titled `@everyone` must not ping the channel.
- **Webhook URLs are validated against Discord's hosts** before use, so a tampered or
  typo'd config can't exfiltrate feed contents to an arbitrary origin.
- **Posts are credited to state per 10-embed message.** A crash mid-run re-sends at most one
  message worth of items; everything not yet delivered is retried next run.
- **Feeds are polled sequentially.** Ten feeds finish in seconds, and parallel posting to
  one webhook just earns 429s.
- **Discord's documented limits are enforced client-side**: 10 embeds/message, 6,000
  characters total per message, and the per-field caps. Exceeding them is a 400, not a
  truncation, so batching accounts for both the count and the character budget.
- **429 handling honours `retry_after` from the response body** (seconds, float, API v8+)
  in preference to the header, and yields proactively when `X-RateLimit-Remaining` hits 0.

## Layout

```
.github/workflows/rss-to-discord.yml  cron, secret injection, state commit
feeds.json                            feeds + filters
state/<id>.json                        per-feed cursor: seen ids, ETag, timestamps
src/runner.mjs                        orchestration + CLI
src/config.mjs                        load + validate (all errors at once, before any I/O)
src/http.mjs                          conditional GET, retries, cause-unwrapping
src/feed.mjs                          RSS 2.0 / RSS 1.0 RDF / Atom → one item shape
src/xml.mjs                           tolerant XML reader + entity decoding + HTML stripping
src/filter.mjs                        regex/age/field filtering
src/discord.mjs                       embed building, batching, rate limits, URL validation
src/state.mjs                          cursor load/save/trim
test/releases.test.mjs                asserts the public/beta split partitions cleanly
```

```bash
npm test
```

## If you outgrow Actions cron

The scheduling sloppiness is the only real weakness. Cloudflare Workers Cron Triggers give
1-minute granularity and reliable firing on the free plan; swap `src/http.mjs`'s caller and
`src/state.mjs` for Workers KV and the rest of the code ports unchanged. Watch KV's free
write limit (1,000/day) — one key per feed per run fits easily.

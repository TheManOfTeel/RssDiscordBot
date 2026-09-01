# RSS → Discord Bot

A lightweight RSS/Atom and ESPN JSON feed relay that posts new items to Discord via webhooks. It runs on GitHub Actions or locally, persists per-feed state in the repo, and enforces Discord embed limits before posting.

---

## What it does

- polls configured feeds on a schedule or from a local run
- normalizes RSS 2.0, RSS 1.0/RDF, Atom, and ESPN JSON feeds into one item model
- filters items with regex include/exclude rules
- deduplicates by GUID/id/link
- posts Discord embeds with batching, rate-limit handling, and webhook validation
- conditionally mentions roles/users via `notify` rules
- stores each feed's cursor and seen IDs in `state/*.json`

This project intentionally has zero runtime dependencies beyond Node.js 20+.

---

## Project layout

```text
.
├── src/
│   ├── config.mjs      load + validate feeds.json
│   ├── discord.mjs     embed limits, mention content, webhook POSTs
│   ├── espn.mjs        ESPN JSON parser
│   ├── feed.mjs        RSS/Atom normalizer
│   ├── filter.mjs      regex filter evaluation
│   ├── http.mjs        HTTP fetch + ETag/Last-Modified handling
│   ├── runner.mjs      CLI + orchestration
│   ├── state.mjs       state load/save helpers
│   └── xml.mjs         tolerant XML parser
├── test/
│   └── *.test.mjs      real behavior tests
├── state/              per-feed state files
├── feeds.json          feed config
├── package.json
├── README.md
└── .github/workflows/rss-to-discord.yml
```

---

## Configuration (`feeds.json`)

The config is JSON, not YAML, and webhook URLs are never committed to the repo. The actual URL must be supplied through a secret and referenced by `webhookEnv`.

```json
{
  "defaults": {
    "webhookEnv": "DISCORD_WEBHOOK",
    "maxPerRun": 5,
    "seenCap": 500,
    "descriptionChars": 400,
    "showDescription": true,
    "showImage": false,
    "showAuthor": true,
    "username": "Feeds",
    "avatarUrl": null,
    "threadId": null,
    "color": null,
    "timeoutMs": 20000,
    "parser": "feed",
    "parserOptions": {}
  },
  "feeds": [
    {
      "id": "apple-newsroom",
      "name": "Apple Newsroom",
      "url": "https://www.apple.com/ca/newsroom/rss-feed.rss",
      "webhookEnv": "DISCORD_WEBHOOK_APPLE_NEWSROOM",
      "username": "Apple Newsroom",
      "color": "#333333",
      "maxPerRun": 5,
      "descriptionChars": 4096,
      "showAuthor": false,
      "showImage": "notified",
      "filters": {
        "fields": ["title", "summary"],
        "include": ["\\biphone\\b", "\\bipad\\b"],
        "exclude": ["\\bApple Intelligence\\b"]
      },
      "notify": [
        {
          "roles": ["1539011756297555998"],
          "summarize": true,
          "when": {
            "fields": ["title", "summary"],
            "include": ["\\b(iPhone|iPad|MacBook|Mac)\\b"]
          }
        }
      ]
    }
  ]
}
```

### Supported feed-level keys

The config validator accepts the following fields:

- `id`: required, unique per feed
- `name`: optional display name
- `url`: required HTTP/HTTPS URL
- `webhookEnv`: required environment variable name
- `maxPerRun`: positive integer, default `5`
- `seenCap`: integer between `10` and `20000`, default `500`
- `descriptionChars`: integer between `0` and `4096`, default `400`
- `showDescription`: boolean, default `true`
- `showImage`: `true`, `false`, or `"notified"`, default `false`
- `showAuthor`: boolean, default `true`
- `username`: optional webhook username override
- `avatarUrl`: optional webhook avatar URL
- `threadId`: optional Discord thread ID
- `timeoutMs`: request timeout in ms, default `20000`
- `color`: hex string like `#5865F2` or integer color value
- `parser`: `feed` or `espn-json`, default `feed`
- `parserOptions`: object passed to the selected parser
- `filters`: filter block
- `notify`: array of notify rules
- `enabled`: set to `false` to skip a feed without deleting it

Any value set in `defaults` is inherited by every feed, and feed-level values override the defaults.

---

## Filters

Filter blocks are compiled once at startup and validated before any requests are made. A bad regex fails fast, not later during a cron run.

```json
{
  "filters": {
    "fields": ["title", "summary", "categories"],
    "include": ["\\brelease\\b", "\\bupdates?\\b"],
    "exclude": ["alpha", "beta"],
    "requireAll": false,
    "requireLink": true,
    "maxAgeHours": 48,
    "flags": "im"
  }
}
```

Supported keys:

- `fields`: array of searchable item fields; valid values are `title`, `summary`, `content`, `author`, `categories`, `link`, `id`
- `include`: regex strings; if `requireAll` is false, at least one must match
- `exclude`: regex strings; any match rejects the item
- `requireAll`: boolean, default `false`
- `requireLink`: boolean, default `true`
- `maxAgeHours`: positive number, optional
- `flags`: regex flags string, default `im`

`defaults.filters` is applied first and then each feed's `filters`; both must pass for an item to be posted.

---

## Notify rules and mentions

`notify` rules decide which Discord roles and users are pinged, and when. The format is intentionally the same filter language as `filters` plus a few message controls.

```json
{
  "notify": [
    {
      "roles": ["123456789012345678"],
      "users": ["987654321012345678"],
      "text": "Breaking news:",
      "batching": true,
      "summarize": false,
      "when": {
        "fields": ["title", "summary"],
        "include": ["\\bcritical\\b", "\\burgent\\b"]
      }
    }
  ]
}
```

Important behavior:

- `roles` and `users` must be Discord snowflake IDs as strings
- `text` is prepended to the top-level message content
- `when` is optional; without it a rule matches every item
- `batching` defaults to `true`; if a matched rule sets it to `false`, that item is sent separately
- `summarize` defaults to `false`; when `true`, message content may be compressed into a brief summary
- multiple matching rules union their mentions, dedupe IDs, and keep the first text value

The bot intentionally rejects placeholder IDs like `000000000000000000` with a warning, not a hard failure, so a dry-run config still runs.

---

## CLI usage

```bash
node src/runner.mjs --help
node src/runner.mjs --dry-run --verbose
node src/runner.mjs --seed --only apple-releases
node src/runner.mjs --config custom-feeds.json --state-dir ./state
```

### Supported options

- `-c, --config <file>`: config file path, default `feeds.json`
- `--state-dir <dir>`: state directory, default `state`
- `--only <ids>`: comma-separated feed ids to restrict the run
- `-n, --dry-run`: fetch + filter + render, but do not post or write state
- `--seed`: treat every feed as first-run and record current IDs without posting
- `--force`: bypass stored ETag/Last-Modified and force a full refetch
- `-v, --verbose`: print item-level filtering and delivery decisions
- `-h, --help`: show CLI help

Exit codes:

- `0`: success
- `1`: one or more feeds failed but others may have succeeded
- `2`: invalid args or bad config

---

## State files

Each feed writes a per-feed JSON state file under `state/<feed-id>.json`:

```json
{
  "version": 1,
  "initialized": true,
  "seen": ["guid-1", "guid-2"],
  "etag": "W/\"123abc\"",
  "lastModified": "Wed, 21 Oct 2025 07:28:00 GMT",
  "lastRun": "2025-10-21T12:34:56.789Z",
  "lastSuccess": "2025-10-21T12:34:56.789Z"
}
```

Behavior:

- first run seeds state and posts nothing
- later runs post only new items not already recorded in `seen`
- state is updated even if some feeds fail, so successful posts are not resent
- `seenCap` drops the oldest IDs first
- corrupt state is reset and reinitialized on the next run

---

## Discord webhook and embed behavior

The webhook URL is read from the environment variable named by `webhookEnv` and is never read from config. The bot validates the URL before POSTing and rejects non-Discord hosts.

Embed rules enforced in code include:

- 10 embeds per message
- 6000 total chars per message
- title max 256
- description max 4096
- footer max 2048
- author name max 256
- 25 fields max
- field name max 256
- field value max 1024
- `content` max 2000

When content exceeds limits, the bot truncates safely rather than sending a broken payload.

---

## Feed parsers

The bot supports these parsers:

- `feed`: standard RSS/Atom parser for XML feeds
- `espn-json`: ESPN JSON news endpoint parser, used for NFL and CFB feeds

The parser name is validated in config, and each parser output is normalized so the rest of the runner never needs to care whether the upstream feed was XML or JSON.

---

## GitHub Actions workflow

The committed workflow at [.github/workflows/rss-to-discord.yml](.github/workflows/rss-to-discord.yml) uses:

- `actions/create-github-app-token@v3` to mint a short-lived app token before checkout
- `actions/checkout@v6`
- `actions/setup-node@v6` with Node 24
- repo secrets for each feed's webhook env var
- a persistent `state/` commit on each run

The workflow is intentionally explicit about env names so the bot can read the secret value for each feed and never hardcode webhook URLs.

---

## Testing

Run the suite with:

```bash
npm test
```

The tests exercise current runtime behavior, including:

- config validation and defaults inheritance
- placeholder IDs and snowflake validation
- parser selection and JSON config structure
- filter compilation and include/exclude behavior
- runner batching and mention grouping
- showImage notifications and per-feed state behavior
- Discord webhook request validation and retry logic
- XML and JSON feed parsing
- end-to-end runs with stubbed fetches

---

## Operational notes

- the first run for a feed seeds state and posts nothing
- any feed-specific item mention or batching logic is keyed off the matched rule set, not a global default
- renaming a feed `id` creates a new state file and effectively re-seeds that feed
- branch protection or repo policy can block the state-commit push, so the workflow handles rebase/retry behavior
- GitHub cron is best-effort; for precise schedules, use a dedicated scheduler or trigger manually

---

## Adding a new feed

1. Create a Discord webhook in the target channel
2. Add the URL as a repository secret
3. Add a new entry to `feeds.json`
4. Validate locally with a dry run:

```bash
npm run dry -- --only my-new-feed
```

5. Once the feed looks right, seed it:

```bash
npm run seed -- --only my-new-feed
```

6. Commit and push the config and new state file

---

## Troubleshooting

### No items are posted

- run `npm run dry -- --only <feed-id> --verbose`
- confirm the filter block matches the actual item text
- check whether the first run has only seeded state yet
- verify the webhook secret is present for the configured `webhookEnv`

### Items appear but do not ping

- confirm the `notify` rule is matching the item fields
- verify the role/user IDs are real Discord snowflakes
- check whether `batching` or `summarize` overrides are involved

### State looks wrong

- inspect `state/<feed-id>.json`
- remove or rename the state file to re-seed a feed
- rerun with `--verbose` to see what the bot thinks it processed

---

## Requirements

- Node.js 20+
- GitHub Actions runner or local machine access to fetch feeds
- Discord webhook permissions for the target channel
- repository secrets for each configured `webhookEnv`

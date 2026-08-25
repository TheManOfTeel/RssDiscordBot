# RSS → Discord Bot

A lightweight, serverless RSS/Atom feed aggregator that posts new items to Discord via webhooks. Designed to run on GitHub Actions cron schedules with zero external dependencies and state persistence directly in the repository.

**Key differentiators**: No databases, no background servers, no external state stores—just JSON config, per-feed state files, and selective regex filtering. Optimized for reliability, auditability, and minimal operational overhead.

---

## Overview

This bot:
- **Polls RSS/Atom feeds** on a schedule (via GitHub Actions cron or local runs)
- **Filters items** with regex-based include/exclude rules (global and per-feed)
- **Deduplicates** by guid/id/link to avoid re-posting
- **Routes to Discord** via webhooks with rich embed formatting
- **Persists state** as JSON files in the repo (seen IDs, ETags, last-run timestamps)
- **Mentions users/roles** conditionally based on item content
- **Respects Discord limits** (10 embeds/message, 6000 chars total, etc.)
- **Handles rate-limits** and HTTP caching (304 Not Modified)

**No dependencies**: Zero npm packages. Only Node.js ≥20.

---

## Architecture

### Core Modules

| Module | Purpose |
|--------|---------|
| **runner.mjs** | Main entry point; CLI, orchestration, state I/O |
| **config.mjs** | Parse and validate feeds.json; compile regexes |
| **feed.mjs** | Normalize RSS 2.0, RSS 1.0/RDF, Atom feed formats |
| **filter.mjs** | Regex matching against item fields (title, summary, content, etc.) |
| **http.mjs** | HTTP fetching with ETag/Last-Modified (conditional GET) |
| **discord.mjs** | Format embeds, truncate to limits, post via webhook |
| **state.mjs** | Load/save per-feed state JSON; dedupe tracking |
| **xml.mjs** | Tolerant XML parsing (handles malformed feeds gracefully) |

### Data Flow

```
feeds.json
    ↓
config.mjs (validate, compile filters)
    ↓
runner.mjs (per feed)
    ├→ http.mjs (fetch with ETag)
    ├→ feed.mjs (parse XML)
    ├→ filter.mjs (regex match)
    ├→ state.mjs (dedupe)
    ├→ discord.mjs (format embeds)
    └→ state.mjs (save seen IDs)
```

---

## Installation

### Prerequisites
- **Node.js** ≥20
- A Discord server with webhook creation permissions
- For GitHub Actions: a repository with GitHub Actions enabled

### Local Setup

```bash
git clone <repo>
cd rss-discord-bot
# No npm install needed
node src/runner.mjs --help
```

---

## Configuration

### feeds.json Structure

The config is **JSON, not YAML** to eliminate dependencies and supply-chain risk in an unattended cron job.

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
    "color": null,
    "timeoutMs": 20000,
    "filters": []
  },
  "feeds": [
    {
      "id": "my-feed",
      "name": "My Feed",
      "url": "https://example.com/feed.xml",
      "webhookEnv": "DISCORD_WEBHOOK_FEED",
      "username": "My Feed Bot",
      "color": "#0099ff",
      "maxPerRun": 3,
      "descriptionChars": 500,
      "showImage": true,
      "threadId": "1234567890",
      "filters": {
        "include": ["important", "release"],
        "exclude": ["draft", "wip"]
      },
      "notify": [
        {
          "roles": ["123456789"],
          "users": ["987654321"],
          "text": "Breaking news:",
          "when": {
            "fields": ["title"],
            "include": ["breaking"]
          }
        }
      ]
    }
  ]
}
```

### Default Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `webhookEnv` | string | `DISCORD_WEBHOOK` | Env var name containing webhook URL |
| `maxPerRun` | number | `5` | Max items posted per feed per run |
| `seenCap` | number | `500` | Max IDs to track in state (oldest dropped first) |
| `descriptionChars` | number | `400` | Max chars for item description in embed |
| `showDescription` | boolean | `true` | Include item summary/description |
| `showImage` | boolean | `false` | Include item image in embed |
| `showAuthor` | boolean | `true` | Include item author in embed |
| `username` | string | `undefined` | Override webhook username |
| `avatarUrl` | string | `undefined` | Override webhook avatar |
| `color` | string/number | `undefined` | Embed color (#RRGGBB, RRGGBB, or 0xRRGGBB) |
| `timeoutMs` | number | `20000` | HTTP request timeout |
| `threadId` | string | `undefined` | Post to specific Discord thread (snowflake) |

### Per-Feed Overrides

Any default setting can be overridden at the feed level (e.g., `"maxPerRun": 10` for a specific feed).

---

## Filtering

Filters are **regex patterns** applied to feed items. They are compiled once at startup—a bad pattern fails immediately, not at 3 AM.

### Filter Configuration

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

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `fields` | array | `["title", "summary", "categories"]` | Fields to search: title, summary, content, author, categories, link, id |
| `include` | array\|string | `[]` | Regex patterns—item must match at least one (or all if requireAll=true) |
| `exclude` | array\|string | `[]` | Regex patterns—item must NOT match any |
| `requireAll` | boolean | `false` | If true, item must match ALL include patterns (not just one) |
| `requireLink` | boolean | `false` | If true, reject items without a link |
| `maxAgeHours` | number | `undefined` | Drop items older than N hours |
| `flags` | string | `"im"` | Regex flags: i=case-insensitive, m=multiline, etc. |

### Filter Application

- **Global filters** from `defaults.filters` apply first (blocklist, typically)
- **Per-feed filters** apply next (include/exclude for that feed)
- Both must pass for an item to be posted

### Example: Apple Products Only

```json
{
  "id": "apple-newsroom",
  "name": "Apple Newsroom",
  "url": "https://www.apple.com/ca/newsroom/rss-feed.rss",
  "filters": {
    "fields": ["title", "summary"],
    "include": ["\\biphone\\b", "\\bmac(book)?\\b", "\\bipad\\b", "\\bvision pro\\b", "\\bapple watch\\b", "\\bairpods\\b", "\\bapple tv\\b.*\\b(4k|device|hardware|box)\\b", "\\b(4k|device|hardware|box)\\b.*\\bapple tv\\b", "\\bhomepod\\b"]
  }
}
```

**Note**: JSON requires backslash escaping. The regex `\bword\b` becomes `"\\bword\\b"` in JSON.

---

## Notifications & Mentions

Conditionally mention Discord roles or users based on item content.

```json
{
  "notify": [
    {
      "roles": ["1234567890", "9876543210"],
      "users": ["5555555555"],
      "text": "Priority alert:",
      "when": {
        "fields": ["title"],
        "include": ["critical", "urgent"]
      }
    },
    {
      "roles": ["1111111111"],
      "text": "Release notice:",
      "when": {
        "fields": ["title", "summary"],
        "include": ["release"],
        "maxAgeHours": 24
      }
    }
  ]
}
```

**Key points**:
- `roles`, `users` → Discord snowflake IDs (as **strings** in JSON, since 19-digit IDs exceed `Number.MAX_SAFE_INTEGER`)
- `text` → Mention text prepended to the embed
- `when` → Filter for this rule (same structure as `filters`)
- A rule matches only if its `when` condition is satisfied
- Multiple matching rules → mentions accumulate

---

## CLI Usage

### Commands

```bash
# Start the bot (fetch, filter, post)
npm start

# Dry-run: fetch, filter, render—but don't POST or save state
npm run dry

# Seed: mark all current items as seen, don't post
npm run seed

# Run with options
node src/runner.mjs [options]
```

### Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--config <file>` | `-c` | `feeds.json` | Config file path |
| `--state-dir <dir>` | | `state` | Directory for state JSON files |
| `--only <ids>` | | (all) | Comma-separated feed IDs to run (e.g., `feed1,feed2`) |
| `--dry-run` | `-n` | false | Fetch/filter/render, but don't POST or write state |
| `--seed` | | false | Treat all feeds as first-run: record IDs, post nothing |
| `--force` | | false | Ignore stored ETag/Last-Modified; force full download |
| `--verbose` | `-v` | false | Log each item and filtering decisions |
| `--help` | `-h` | | Show usage |

### Examples

```bash
# Dry-run with verbose output
node src/runner.mjs --dry-run --verbose

# Seed only one feed (first-run initialization)
node src/runner.mjs --seed --only apple-newsroom

# Force re-download (bypass caching)
node src/runner.mjs --force

# Custom state directory
node src/runner.mjs --config my-feeds.json --state-dir ./custom-state
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Feed error (one or more feeds failed; others may have succeeded) |
| `2` | Bad arguments, invalid config, or critical error |

---

## State Management

Per-feed state is stored in `state/<feed-id>.json`:

```json
{
  "version": 1,
  "initialized": true,
  "seen": ["guid-1", "guid-2", "guid-3"],
  "etag": "W/\"123abc\"",
  "lastModified": "Wed, 21 Oct 2025 07:28:00 GMT",
  "lastRun": "2025-10-21T12:34:56.789Z",
  "lastSuccess": "2025-10-21T12:34:56.789Z"
}
```

### State File Lifecycle

1. **First run**: State is seeded with all current item IDs; nothing is posted.
2. **Subsequent runs**: New items (not in `seen`) are posted and added to `seen`.
3. **Deduplication**: Uses item `guid`, `id`, or `link` (first found).
4. **Capping**: `seenCap` limits the array size; oldest IDs are dropped first.
5. **Corruption**: If a state file is corrupt, it's reset and logged.

### Why State in the Repo?

- **Durable**: Survives GitHub Actions cache eviction (7-day limit)
- **Auditable**: Commit history shows what was delivered
- **Activity**: Regular commits keep scheduled workflows from auto-disabling
- **Portable**: State is queryable and debuggable in version control

### Conditional GET (HTTP Caching)

The bot stores and respects:
- **ETag** (if-none-match header) → 304 Not Modified
- **Last-Modified** (if-modified-since header) → 304 Not Modified

A 304 response costs zero body transfer and is significantly faster. Most well-maintained feeds support it.

---

## Discord Integration

### Embed Format

Each item is posted as a Discord embed:

```json
{
  "title": "Item Title",
  "url": "https://example.com/item",
  "description": "Item summary (truncated to descriptionChars)",
  "timestamp": "2025-10-21T12:34:56Z",
  "color": 16711680,
  "author": { "name": "Author Name" },
  "footer": { "text": "Feed Name" },
  "image": { "url": "https://example.com/image.jpg" }
}
```

### Discord Limits (Enforced)

| Limit | Value |
|-------|-------|
| Embeds per message | 10 |
| Total characters per message | ~6000 |
| Embed title | 256 chars |
| Embed description | 4096 chars |
| Embed footer | 2048 chars |
| Embed author name | 256 chars |
| Embed field name | 256 chars |
| Embed field value | 1024 chars |
| Embed fields | 25 fields |
| Embed color | 0x000000 – 0xFFFFFF |

**Batching**: If a feed produces more items than can fit in one message, they are split into multiple messages with a ~1-second gap (webhook rate limit: ~30 msgs/min per channel).

### Webhook Setup

1. **Create Discord Webhook**:
   - Right-click channel → Integrations → Webhooks → New Webhook
   - Copy the webhook URL

2. **Store as Secret**:
   - Go to repo → Settings → Secrets and Variables → Actions
   - Click "New repository secret"
   - Name: `DISCORD_WEBHOOK` (or your custom name)
   - Value: paste the webhook URL
   - **Never commit the URL directly to feeds.json**

3. **Reference in Config**:
   ```json
   {
     "defaults": { "webhookEnv": "DISCORD_WEBHOOK" },
     "feeds": [{ "id": "...", "url": "...", "webhookEnv": "DISCORD_WEBHOOK" }]
   }
   ```

---

## RSS/Atom Feed Support

The bot normalizes:
- **RSS 2.0** (most common)
- **RSS 1.0 / RDF**
- **Atom 1.0**

### Tolerant Parsing

The XML parser is deliberately **not** a strict conforming parser. Feeds in the wild are often malformed (unescaped ampersands, missing close tags, undefined HTML entities). The parser:
- Continues on errors (doesn't throw)
- Handles common HTML entities (©, –, …, etc.)
- Preserves text content even if markup is broken

This prevents a single bad character from breaking an entire feed.

---

## Testing

### Running Tests

```bash
npm test
```

Tests are in `test/*.test.mjs` and cover:
- Config loading and validation
- Regex filter compilation and matching
- Feed parsing (RSS, Atom)
- State management (load, save, dedupe)
- Discord embed formatting and limits
- HTTP fetching and retry logic
- Full end-to-end runs

---

## Deployment on GitHub Actions

### Workflow File (.github/workflows/rss-to-discord.yml)

```yaml
name: Poll RSS Feeds

on:
  schedule:
    # See the committed workflow for the complete feed-specific UTC schedule.
    - cron: '0,30 16-23 * * 1-5'  # Release feeds: every 30 minutes in the Pacific safety envelope
    - cron: '17 13-23 * * *'      # News feeds: hourly in the Pacific safety envelope
  workflow_dispatch:         # Manual trigger

jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Poll feeds
        run: npm start
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
          DISCORD_WEBHOOK_APPLE_NEWSROOM: ${{ secrets.DISCORD_WEBHOOK_APPLE_NEWSROOM }}

      - name: Commit state changes
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add state/
          git diff --quiet && git diff --staged --quiet || git commit -m "Update feed state"
          git push
```

### Environment Variables

List all `webhookEnv` references in the `env:` section so GitHub Actions injects them.

### Scheduling

GitHub Actions cron is UTC-only and best-effort, so the workflow uses a fixed UTC safety
envelope rather than maintaining separate PST/PDT schedules:

- The two Apple release feeds run every 30 minutes during approximately 8 AM–6 PM Pacific.
- The Apple Newsroom and Apple Developer news feeds run hourly at `:17` in a fixed UTC safety
  envelope covering approximately 5 AM–7 PM Pacific, with extra coverage around daylight saving.
- Outside that news safety envelope, news feeds run every 2 hours.
- Manual dispatch with an empty `only` input polls all feeds; `only` can target specific feeds.

---

## Development

### Project Structure

```
.
├── src/
│   ├── runner.mjs          CLI, orchestration
│   ├── config.mjs          Config loading
│   ├── feed.mjs            Feed parsing
│   ├── filter.mjs          Regex filtering
│   ├── http.mjs            HTTP + caching
│   ├── discord.mjs         Embed formatting
│   ├── state.mjs           State persistence
│   └── xml.mjs             XML parsing
├── test/
│   └── *.test.mjs          Tests
├── state/                  Per-feed state files
├── feeds.json              Config
├── package.json            Metadata
└── README.md               (this file)
```

### Adding a New Feed

1. Create a Discord webhook in the target channel
2. Add the webhook URL as a repository secret
3. Add an entry to `feeds.json`:
   ```json
   {
     "id": "my-new-feed",
     "name": "Display Name",
     "url": "https://example.com/feed.rss",
     "webhookEnv": "DISCORD_WEBHOOK_MY_NEW_FEED"
   }
   ```
4. Test locally:
   ```bash
   npm run dry -- --only my-new-feed
   ```
5. Once satisfied, seed the state:
   ```bash
   npm run seed -- --only my-new-feed
   ```
6. Commit `feeds.json` and the new state file, then push.

### Debugging

```bash
# See all items and filtering decisions
npm run dry -- --verbose

# See a specific feed's state
cat state/my-feed.json

# Re-seed a single feed (for a fresh start)
npm run seed -- --only my-feed

# Force re-download (bypass caching)
npm start -- --force
```

---

## Troubleshooting

### Feed produces no items
1. Check if the feed is valid: `npm run dry -- --only <feed-id> --verbose`
2. Are there global filters blocking it? Check `defaults.filters`
3. Is it the first run? First run seeds—no posts until the second run
4. Check Discord rate limits—the webhook may be throttled

### Items not appearing in Discord
1. **Filter mismatch**: Run with `--verbose` to see which items are dropped and why
2. **Webhook URL invalid**: Check the secret in GitHub Settings
3. **Webhook deleted**: Discord webhooks can expire; recreate it
4. **Embed size exceeded**: An item might exceed 6000 total chars; enable truncation or lower `descriptionChars`

### Webhook keeps timing out
1. Check `timeoutMs` in config (default 20s)
2. Network issues? Run locally first: `npm run dry`
3. Feed server down? Check the URL manually

### State file corrupt
The bot detects corrupt state and resets it automatically, logging a warning. The next run will re-seed.

---

## Performance Notes

- **No external dependencies**: Zero npm packages to update or audit
- **Minimal memory**: Regexes compiled once at startup
- **HTTP caching**: ETag/Last-Modified reduce bandwidth and time
- **Conditional logic**: Global filters applied before per-feed filters (fail fast)
- **GitHub Actions**: Runs in seconds (~2–10s per feed, depending on feed size)

---

## Secrets & GitHub App Token

The workflow commits state changes to the repo. To avoid being blocked by branch protections and to allow specific authorization of the bot:

1. **Create a GitHub App**:
   - Go to Settings → Developer settings → GitHub Apps → New GitHub App
   - Set permissions: `Contents` → Read & Write
   - Install on this repository
   - Generate a private key

2. **Store as Secrets**:
   - Add `BOT_APP_ID` with the App ID value
   - Add `BOT_PRIVATE_KEY` with the generated private key PEM content

3. **Reference in Workflow**:
   - The workflow uses `actions/create-github-app-token@v3` to mint a short-lived token
   - This token is used for state commits instead of `GITHUB_TOKEN`, allowing it to bypass protected branch rules

See [.github/workflows/rss-to-discord.yml](.github/workflows/rss-to-discord.yml) for the full implementation.

---

## Operational Notes

- **GitHub cron is best-effort**: Runs may be delayed during heavy load
- **Renaming a feed id**: Creates a new state file and re-seeds the feed
- **Widening filters**: Does not backfill old items; delete `state/<id>.json` to reprocess history
- **Branch protections**: If branch rules block the bot, state commits will fail and cause duplicate postings on retry
- **Concurrent runs**: The workflow uses `concurrency.cancel-in-progress: false` to serialize state updates and prevent races

---

## When to Consider Alternatives

This bot is optimized for low operational overhead on GitHub Actions. Consider alternatives if you need:
- **Strict 1-minute scheduling**: GitHub cron is best-effort; use another scheduler (cron server, Cloudflare Workers, AWS Lambda, etc.)
- **Persistent external state**: If you need state to survive repo deletion, use a database or key-value store
- **Complex multi-feed logic**: For advanced event routing and aggregation, consider a message queue or rules engine

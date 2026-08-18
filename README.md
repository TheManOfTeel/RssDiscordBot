# rss-discord-bot

A compact relay that polls RSS/Atom feeds and posts new items to Discord via webhooks. Runs on GitHub Actions with per-feed state stored in the repo. Focused on reliability, simple ops, and predictable filtering/routing.

Purpose
- Relay RSS/Atom → Discord with flexible regex filters, per-feed routing, batching, and controlled mentions.
- Low operational surface: no servers, no external state store, minimal runtime dependencies.

Highlights
- Scheduled GitHub Actions job.
- Per-feed state under state/<id>.json (seen ids, ETag, timestamps).
- Regex-based include/exclude filters, applied per-feed and globally.
- Dedupe by guid/id/link (not by date).
- Conditional GETs (ETag/If-Modified-Since) and rate-limit handling.

Quick config
- feeds.json contains defaults and an array of feed objects. Each feed needs an id and url. Use webhookEnv to reference a repository secret that holds the Discord webhook URL (never commit webhook URLs).

Minimal feeds.json example
```json
{
  "defaults": { "webhookEnv": "DISCORD_WEBHOOK", "maxPerRun": 5 },
  "feeds": [
    { "id": "example", "name": "Example", "url": "https://example.com/rss", "webhookEnv": "DISCORD_WEBHOOK_EXAMPLE" }
  ]
}
```

Notes: webhookEnv is the name of a secret; any webhookEnv used must also be declared under env: in .github/workflows/rss-to-discord.yml so Actions injects it.

Key behaviors
- First run seeds: records current ids and posts nothing.
- Filters: defaults.filters and feed.filters both apply (global blocklist + per-feed rules). Filters are arrays of regexes against configured fields (title, summary, content, categories, etc.).
- notify rules control mentions; role/user IDs must be JSON strings (quote 19-digit snowflakes).
- Overflow beyond maxPerRun: newer items posted, others marked seen and dropped.
- Batching enforces 10 embeds/message and ~6000-character limit.

Runner / CLI
- --dry-run — fetch/filter/render, POST nothing, write no state.
- --seed — record current ids as seen, post nothing.
- --only id1,id2 — restrict to specific feeds.
- --force — ignore stored ETag/Last-Modified.

Exit codes: 0 OK, 1 feed error, 2 bad args/config.

Run examples (Node)

```bash
# Dry-run: fetch/filter/render, post nothing
node src/runner.mjs --dry-run --verbose

# Seed: mark current items seen, post nothing
node src/runner.mjs --seed

# Run only specific feeds
node src/runner.mjs --only example,other
```

Secrets & push identity
- Store webhook URLs as repository secrets referenced by webhookEnv.
- The workflow commits state using a GitHub App token; create a GitHub App with Contents: Read & Write, generate a private key, install it on this repo, then add BOT_APP_ID and BOT_PRIVATE_KEY as repository secrets.

Tests
- npm test (82 unit tests; no network required).

Files of interest
- .github/workflows/rss-to-discord.yml — schedule, secret injection, state commit
- feeds.json — feeds + filter config
- state/<id>.json — per-feed cursor (seen ids, ETag)
- src/runner.mjs — orchestration + CLI
- src/{config,http,feed,xml,filter,discord,state}.mjs — core functionality

Operational notes
- GitHub cron is best-effort; runs may be delayed.
- Renaming a feed id creates a new state file and re-seeds.
- Widening filters does not backfill; delete state/<id>.json to reprocess history.
- Branch protections that block the bot will cause state commits to fail and duplicate postings.

When to consider alternatives
- If you need strict 1-minute scheduling or higher trigger reliability, run the code on another scheduler and swap the state backend (e.g., Cloudflare Workers + KV).

# rss-discord-bot

A tiny GitHub Actions cron that relays RSS/Atom → Discord webhooks with regex filtering, dedupe, and per-feed state stored in the repo.

- Zero servers, no runtime dependencies. Runs on GitHub Actions.
- Per-feed state kept in state/<id>.json; commits back to the repo.

## Quick start

1. Fork or push this repo (public recommended).
2. Create Discord webhooks for target channels and add them as repo secrets (names referenced by each feed's webhookEnv).
3. Create a GitHub App with Contents: Read & Write, generate a private key, install on this repo, and add BOT_APP_ID and BOT_PRIVATE_KEY as secrets.
4. Edit feeds.json, seed cursors, then run the workflow once in Actions.

Run common tasks from a machine (example in C#):

```csharp
using System.Diagnostics;

void Run(string args) {
    var p = Process.Start(new ProcessStartInfo("node", $"src/runner.mjs {args}") { RedirectStandardOutput = true });
    p.WaitForExit();
    Console.WriteLine(p.StandardOutput.ReadToEnd());
}

// Dry-run (no state change, no webhooks needed)
Run("--dry-run --verbose");
// Seed (record current ids; posts nothing)
Run("--seed");
```

## Minimal feeds.json example

```json
{
  "defaults": { "webhookEnv": "DISCORD_WEBHOOK", "maxPerRun": 5 },
  "feeds": [
    { "id": "example", "name": "Example", "url": "https://example.com/rss", "webhookEnv": "DISCORD_WEBHOOK_EXAMPLE" }
  ]
}
```

Notes:
- Use webhookEnv (secret name), never embed webhook URLs in feeds.json.
- Every webhookEnv used must be listed under env: in .github/workflows/rss-to-discord.yml so Actions injects the secret.

## Key behaviors (short)

- Dedupe by guid/id/link (not date).
- Conditional GET (ETag/If-Modified-Since) to minimize work and bandwidth.
- First run seeds (no posts).
- Filters are regex-based. defaults.filters and feed.filters are both applied (global blocklist + per-feed rules).
- notify rules control mentions; IDs must be JSON strings (quote 19-digit snowflakes).
- Respect Discord limits: 10 embeds/message and ~6000 character limit; batching is automatic.

## CLI

Run the runner directly (see C# example above):

node/src CLI options:
- --dry-run: fetch/filter/render, post nothing, write no state.
- --seed: mark current items as seen, post nothing.
- --only id1,id2: restrict to specific feeds.
- --force: ignore stored ETag/Last-Modified.

Exit codes: 0 ok, 1 feed error, 2 bad args/config.

## Tests

Run locally:

```bash
npm test
```

(82 unit tests; no network required.)

## Cost & scheduling

- Public repo + ubuntu-latest runners: free.
- Private repo: consumes Actions minutes from your plan.
- The shipped schedule balances latency and minutes; adjust the workflow cron to change frequency.

## Files of interest

- .github/workflows/rss-to-discord.yml — schedule, secret injection, state commit
- feeds.json — feeds + filters
- state/<id>.json — per-feed cursor (seen ids, ETag)
- src/runner.mjs — orchestration + CLI
- src/* — parser, filter, discord poster, state

## Operational notes

- GitHub cron is best-effort and can be delayed.
- Renaming a feed id re-seeds (creates a new state file).
- Widening filters does not backfill; delete state/<id>.json to backfill.
- Branch protections that block the bot will cause state commits to fail and reposts.

License: MIT

/**
 * Discord webhook delivery.
 *
 * Documented limits enforced here (Discord developer docs, "Embed Limits"):
 *   10 embeds per message; title 256; description 4096; field name 256; field value 1024;
 *   footer 2048; author name 256; 25 fields; and 6000 characters TOTAL across every embed
 *   in one message. Exceeding any of them is a 400, not a truncation.
 *
 * Webhooks are additionally throttled to roughly 30 messages/minute per channel, which is
 * separate from the per-route bucket reported in the X-RateLimit-* headers. `minGapMs`
 * below is the budget for that; the headers handle the rest.
 */

export const LIMITS = {
  EMBEDS_PER_MESSAGE: 10,
  TOTAL_CHARS: 6000,
  TITLE: 256,
  DESCRIPTION: 4096,
  FOOTER: 2048,
  AUTHOR_NAME: 256,
  FIELDS: 25,
  FIELD_NAME: 256,
  FIELD_VALUE: 1024,
  CONTENT: 2000,
  IOS_FRIENDLY_SUMMARY_LIMIT: 400, // Optimal length for mobile push + channel preview
};

export class DiscordError extends Error {
  constructor(status, body) {
    super(`Discord responded ${status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export class EmbedSizeOverflowError extends Error {
  constructor(embed, cost, max) {
    super(`Embed size ${cost} exceeds limit ${max}: ${JSON.stringify(embed).slice(0, 500)}`);
    this.embed = embed;
    this.cost = cost;
    this.max = max;
  }
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Truncate to `max` characters, ellipsis included in the budget. */
export function clip(value, max) {
  if (value == null) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Drop undefined/null/empty members so Discord never sees a null it rejects. */
export function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value == null) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** Characters Discord counts against the 6000-per-message budget. */
export function embedCharCount(embed) {
  let total = 0;
  total += (embed.title ?? '').length;
  total += (embed.description ?? '').length;
  total += (embed.footer?.text ?? '').length;
  total += (embed.author?.name ?? '').length;
  for (const field of embed.fields ?? []) total += (field.name ?? '').length + (field.value ?? '').length;
  return total;
}

/** Clamp every embed field to its documented maximum. */
export function sanitizeEmbed(embed) {
  const out = compact({
    title: clip(embed.title, LIMITS.TITLE),
    url: embed.url,
    description: clip(embed.description, LIMITS.DESCRIPTION),
    timestamp: embed.timestamp,
    color: Number.isInteger(embed.color) ? embed.color : undefined,
    author: embed.author?.name ? compact({ name: clip(embed.author.name, LIMITS.AUTHOR_NAME), url: embed.author.url }) : undefined,
    footer: embed.footer?.text ? compact({ text: clip(embed.footer.text, LIMITS.FOOTER) }) : undefined,
    image: embed.image?.url ? { url: embed.image.url } : undefined,
    fields: (embed.fields ?? []).slice(0, LIMITS.FIELDS).map((f) => ({
      name: clip(f.name, LIMITS.FIELD_NAME) ?? '​',
      value: clip(f.value, LIMITS.FIELD_VALUE) ?? '​',
      inline: f.inline === true,
    })),
  });
  return out;
}

/**
 * Truncate an embed to fit the 6000-character budget.
 * Tries to trim the description first, then drops fields if needed.
 */
function truncateEmbed(embed, maxChars) {
  const currentCost = embedCharCount(embed);
  if (currentCost <= maxChars) return embed;
  const overflow = currentCost - maxChars;
  const cloned = { ...embed };
  if (cloned.description && cloned.description.length > overflow + 3) {
    // Trim description with ellipsis (...)
    cloned.description = cloned.description.slice(0, -(overflow + 3)) + '...';
  } else {
    // If description trim is insufficient, drop fields
    cloned.fields = cloned.fields?.slice(0, Math.max(0, (cloned.fields?.length || 0) - 1));
  }
  return cloned;
}

/** Split embeds into messages respecting both the count cap and the 6000-char cap. */
export function batchEmbeds(embeds, { perMessage = LIMITS.EMBEDS_PER_MESSAGE, totalChars = LIMITS.TOTAL_CHARS, truncateOnOverflow = true } = {}) {
  const sanitizedEmbeds = embeds.map(embed => {
    const cost = embedCharCount(embed);
    if (cost > totalChars) {
      if (truncateOnOverflow) {
        return truncateEmbed(embed, totalChars);
      }
      throw new EmbedSizeOverflowError(embed, cost, totalChars);
    }
    return embed;
  });
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const embed of sanitizedEmbeds) {
    const cost = embedCharCount(embed);
    if (batch.length > 0 && (batch.length >= perMessage || chars + cost > totalChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(embed);
    chars += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

/**
 * Reject anything that is not a Discord webhook URL. This is a secret-exfiltration guard:
 * a typo'd or tampered config must not POST feed contents to an arbitrary host.
 */
export function assertWebhookUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('webhook URL must be https');
  if (!WEBHOOK_HOSTS.has(url.hostname)) throw new Error(`webhook host ${url.hostname} is not a Discord host`);
  if (!/^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    throw new Error('webhook URL path does not look like /api/webhooks/<id>/<token>');
  }
  return url.toString();
}

/**
 * Parse retry-after response header (or body fallback) to milliseconds.
 * Discord returns this after a 429 rate-limit response.
 */
const retryAfterMs = (headers, body) => {
  const fromBody = Number(body?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody * 1000);
  const fromHeader = Number(headers.get('retry-after'));
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.ceil(fromHeader * 1000);
  return 2000;
};

/**
 * Group version-first release summaries (e.g., "1.0.0: iOS, iPadOS") by version,
 * deduplicating platforms.
 * Returns null if the format doesn't match (not a version-first list).
 */
function formatVersionGroups(versionRows) {
  const ordered = [];
  const index = new Map();
  for (const row of versionRows) {
    const match = row.match(/^((?:\d+\.){2,}\d+|\d+\.\d+)(?:\s*(?:-|:)\s*([^\n]+))?$/);
    if (!match) return null;
    const [, version, platformsText = ''] = match;
    const platformList = (platformsText || '')
      .split(/\s*(?:,|\band\b)\s*/i)
      .map((platform) => platform.trim())
      .filter(Boolean);
    if (!index.has(version)) {
      index.set(version, ordered.length);
      ordered.push({ version, platforms: [] });
    }
    const entry = ordered[index.get(version)];
    for (const platform of platformList) {
      if (!entry.platforms.includes(platform)) entry.platforms.push(platform);
    }
  }
  return ordered.map(({ version, platforms }) => `${version}: ${platforms.join(', ')}`).join('\n');
}

/**
 * Group mixed platform/version release summaries (e.g., "iOS 1.0.0 iPadOS 1.0.0")
 * into version-grouped lines. Returns null if no platform/version pairs are found.
 */
function formatMixedPlatformVersions(text) {
  const matches = [...text.matchAll(/\b([A-Za-z]+(?:OS|OSX))\s+((?:\d+\.){2,}\d+|\d+\.\d+)(?:\s*\([^)]*\))?/g)];
  if (matches.length === 0) return null;

  const ordered = [];
  const index = new Map();
  for (const match of matches) {
    const [, platform, version] = match;
    if (!index.has(version)) {
      index.set(version, ordered.length);
      ordered.push({ version, platforms: [] });
    }
    const entry = ordered[index.get(version)];
    if (!entry.platforms.includes(platform)) entry.platforms.push(platform);
  }
  return ordered.map(({ version, platforms }) => `${version}: ${platforms.join(', ')}`).join('\n');
}

/**
 * Build the `content` string that actually pings.
 *
 * Mentions inside an embed are inert text — Discord never notifies from embed fields. The
 * mention has to be in the message's top-level `content`, and `allowed_mentions` has to
 * permit it, or it renders as a highlighted-but-silent mention.
 *
 * @param {object} options - { roles, users, text } for mention data; summary is the embed content
 * @param {string} summary - Feed item summary, possibly an OS release formatted string
 * @param {boolean} summarize - Whether to apply algorithmic summarization (TF-IDF sentence scoring)
 * @returns {string|undefined} Ping mention(s) optionally followed by formatted content
 */
export function mentionContent({ roles = [], users = [], text } = {}, summary = '', summarize = false) {
  const mentions = [
    ...(roles ?? []).map((id) => `<@&${id}>`),
    ...(users ?? []).map((id) => `<@${id}>`)
  ];
  const pings = [...mentions, text].filter(Boolean).join(' ');
  // Reserve space for pings + newline (\n) if pings exist
  const pingOffset = pings.length > 0 ? pings.length + 1 : 0;
  const availableBodyChars = Math.max(0, LIMITS.CONTENT - pingOffset);
  // Target the smaller of the iOS mobile limit or available space
  const targetLength = Math.min(LIMITS.IOS_FRIENDLY_SUMMARY_LIMIT, availableBodyChars);
  let formattedSummary = summary ?? '';

  const rows = formattedSummary.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const isVersionFirstRelease = rows.length > 0 && rows.every((line) => /^((?:\d+\.){2,}\d+|\d+\.\d+)(?:\s*(?:-|:)\s*.*)?$/.test(line));
  if (isVersionFirstRelease) {
    const grouped = formatVersionGroups(rows);
    if (grouped) formattedSummary = grouped;
  } else {
    const grouped = formatMixedPlatformVersions(formattedSummary);
    if (grouped) formattedSummary = grouped;
  }

  if (summarize && !formattedSummary.match(/(?:\d+\.){2,}\d+|\d+\.\d+/)) {
    // Automatically set summary length to roughly 20% of the original article length, minimum 1 sentence
    const totalSentencesCount = (formattedSummary.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length;
    const calculatedBounds = Math.max(1, Math.round(totalSentencesCount * 0.2));
    formattedSummary = algorithmicSummarize(formattedSummary, calculatedBounds);
  }
  // Single-pass truncation with ellipsis
  if (formattedSummary.length > targetLength) {
    formattedSummary = formattedSummary.slice(0, Math.max(0, targetLength - 1)).trimEnd() + '…';
  }
  // Join pings and formattedSummary cleanly without leading/trailing newlines
  if (pings.length > 0 && formattedSummary.length > 0) {
    return `${pings}\n${formattedSummary}`;
  }
  return formattedSummary || pings || undefined;
}

/**
 * Build Discord's `allowed_mentions` policy.
 *
 * By default, `parse: []` blocks all mention types. Only explicit IDs in the `roles` or
 * `users` arrays are then allowlisted. This prevents untrusted feed content from pinging
 * via @everyone or @here.
 *
 * @param {object} options - { roles, users } to allowlist
 * @returns {object} Discord allowed_mentions structure
 */
export function allowedMentionsFor({ roles = [], users = [] } = {}) {
  const allowed = { parse: [] };
  if (roles.length > 0) allowed.roles = roles;
  if (users.length > 0) allowed.users = users;
  return allowed;
}

/**
 * Algorithmically summarize text using TF-IDF-like sentence scoring.
 *
 * Extracts the N most important sentences by word frequency, then returns them
 * in chronological order. Stop words (common articles, prepositions) are ignored.
 *
 * @param {string} textString - Input text to summarize
 * @param {number} sentenceCount - Number of top sentences to return (default 2)
 * @returns {string} Summarized text (N sentences in original order)
 */
function algorithmicSummarize(textString, sentenceCount = 2) {
  if (!textString || textString.trim() === '') return '';
  // Define common words to ignore (stop words) so they don't skew the scoring
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 
    'to', 'from', 'by', 'of', 'in', 'is', 'it', 'that', 'this', 'with', 'was', 'as'
  ]);

  // Clean the text and tokenize into individual words to calculate global frequency
  const words = textString.toLowerCase().match(/\b[a-z0-9']+\b/g) || [];
  const wordFrequencies = {};
  let maxFrequency = 0;
  words.forEach(word => {
    if (!stopWords.has(word)) {
      wordFrequencies[word] = (wordFrequencies[word] || 0) + 1;
      if (wordFrequencies[word] > maxFrequency) {
        maxFrequency = wordFrequencies[word];
      }
    }
  });
  // Normalize frequencies between 0 and 1 so long articles don't break the math
  if (maxFrequency > 0) {
    for (const word in wordFrequencies) {
      wordFrequencies[word] /= maxFrequency;
    }
  }

  // Split the text into actual sentences
  // Uses a basic regex split on punctuation followed by spaces
  const sentences = textString.match(/[^.!?]+[.!?]+(\s|$)/g) || [textString];
  const sentenceScores = [];
  // 4. Score each sentence by adding up the normalized weights of its words
  sentences.forEach((sentence, index) => {
    const sentenceWords = sentence.toLowerCase().match(/\b[a-z0-9']+\b/g) || [];
    let score = 0;
    sentenceWords.forEach(word => {
      if (wordFrequencies[word]) {
        score += wordFrequencies[word];
      }
    });
    // Save the original sentence text, its score, and its original order index
    sentenceScores.push({ text: sentence.trim(), score, index });
  });

  // Sort sentences by score to find the most important ones
  const topSentences = sentenceScores
    .sort((a, b) => b.score - a.score)
    .slice(0, sentenceCount);
  // Re-sort the top sentences back into their original chronological order
  const finalSummary = topSentences
    .sort((a, b) => a.index - b.index)
    .map(s => s.text)
    .join(' ');
  return finalSummary;
}

/**
 * POST embeds to a Discord webhook, batched, with rate-limit awareness.
 *
 * Splits embeds into messages respecting both the per-message embed cap (10)
 * and the total character budget (6000 per message). Handles 429 rate limits
 * with exponential backoff.
 *
 * @param {string} webhookUrl - Discord webhook URL
 * @param {object[]} embeds - Array of embed objects to post
 * @param {object} options - Configuration including retry, gap, and logging options
 * @returns {Promise<{messages: number, embeds: number}>} Count of posted messages and embeds
 */
export async function postEmbeds(webhookUrl, embeds, {
  content,
  allowedMentions,
  username,
  avatarUrl,
  threadId,
  fetchImpl = fetch,
  sleep = sleepDefault,
  maxRetries = 5,
  minGapMs = 1300,
  maxSleepMs = 60_000,
  dryRun = false,
  log = () => {},
} = {}) {
  if (embeds.length === 0) return { messages: 0, embeds: 0 };
  const target = assertWebhookUrl(webhookUrl);
  const batches = batchEmbeds(embeds.map(sanitizeEmbed));
  const endpoint = new URL(target);
  // Wait=true surfaces creation failures instead of fire-and-forget
  endpoint.searchParams.set('wait', 'true');
  if (threadId) endpoint.searchParams.set('thread_id', String(threadId));

  let messages = 0;
  for (const [index, batch] of batches.entries()) {
    const payload = compact({
      // Only the first message carries the mention; splitting by character budget must not ping twice.
      content: index === 0 ? content : undefined,
      username: clip(username, 80),
      avatar_url: avatarUrl,
      embeds: batch,
      // Untrusted feed content cannot ping. Default-deny with explicit allowlist only.
      allowed_mentions: allowedMentions ?? { parse: [] },
    });

    if (dryRun) {
      log(`  [dry-run] would POST ${batch.length} embed(s)`);
      messages++;
      continue;
    }

    if (index > 0) await sleep(minGapMs);

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(endpoint.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'rss-discord-bot/1.0',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });

      if (res.status === 429) {
        let body;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        if (attempt >= maxRetries) throw new DiscordError(429, body ?? 'rate limited, retries exhausted');
        const wait = Math.min(retryAfterMs(res.headers, body) + 250, maxSleepMs);
        log(`  429 rate limited, waiting ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(wait);
        continue;
      }

      if (res.status >= 500) {
        if (attempt >= maxRetries) throw new DiscordError(res.status, await res.text().catch(() => ''));
        const wait = Math.min(1000 * 2 ** attempt, maxSleepMs);
        log(`  ${res.status} from Discord, waiting ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(wait);
        continue;
      }

      // 202 Accepted is unexpected (we use wait=true for 200). Still retry with backoff;
      // the exhaustion check prevents infinite loops in case of a broken endpoint.
      if (res.status === 202) {
        if (attempt >= maxRetries) throw new DiscordError(202, 'accepted with no body, retries exhausted');
        const wait = Math.min(1000 * 2 ** attempt, maxSleepMs);
        log(`  202 Accepted — no body, waiting ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new DiscordError(res.status, await res.text().catch(() => ''));

      messages++;
      // Proactively yield when the rate-limit bucket is exhausted
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(resetAfter) && resetAfter > 0) await sleep(Math.min(resetAfter * 1000 + 100, maxSleepMs));
      }
      break;
    }
  }

  return { messages, embeds: embeds.length };
}

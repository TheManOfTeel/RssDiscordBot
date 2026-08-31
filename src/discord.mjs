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

function truncateEmbed(embed, maxChars) {
  const currentCost = embedCharCount(embed);
  if (currentCost <= maxChars) return embed;
  const overflow = currentCost - maxChars;
  const cloned = { ...embed };
  if (cloned.description && cloned.description.length > overflow + 3) {
    // Trim description with an ellipsis indicator (...)
    cloned.description = cloned.description.slice(0, -(overflow + 3)) + '...';
  } else {
    // If description truncation is insufficient, slice fields array down
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

const retryAfterMs = (headers, body) => {
  const fromBody = Number(body?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody * 1000);
  const fromHeader = Number(headers.get('retry-after'));
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.ceil(fromHeader * 1000);
  return 2000;
};

/**
 * POST embeds to a webhook, batched, rate-limit aware.
 *
 * @returns {Promise<{messages: number, embeds: number}>}
 */
/**
 * Build the `content` string that actually pings.
 *
 * Mentions inside an embed are inert text — Discord never notifies from embed fields. The
 * mention has to be in the message's top-level `content`, and `allowed_mentions` has to
 * permit it, or it renders as a highlighted-but-silent mention.
 */
export function mentionContent({ roles = [], users = [], text } = {}, summary = '') {
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
  const rawSummary = summary ?? '';
  // Automatically set summary length to roughly 20% of the original article length, minimum 1 sentence
  const totalSentencesCount = (rawSummary.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length;
  const calculatedBounds = Math.max(1, Math.round(totalSentencesCount * 0.2)); 
  rawSummary = algorithmicSummarize(rawSummary, calculatedBounds);
  let clippedSummary = rawSummary;
  // Single-pass truncation with ellipsis
  if (rawSummary.length > targetLength) {
    clippedSummary = rawSummary.slice(0, Math.max(0, targetLength - 1)).trimEnd() + '…';
  }
  // Join pings and clippedSummary cleanly without leading/trailing newlines
  if (pings.length > 0 && clippedSummary.length > 0) {
    return `${pings}\n${clippedSummary}`;
  }
  return clippedSummary || pings || undefined;
}

/** `parse: []` blocks everything, then the id allowlists re-open exactly what was asked for. */
export function allowedMentionsFor({ roles = [], users = [] } = {}) {
  const allowed = { parse: [] };
  if (roles.length > 0) allowed.roles = roles;
  if (users.length > 0) allowed.users = users;
  return allowed;
}

/** Algorithmic approach to generate summary from input text */
function algorithmicSummarize(textString, sentenceCount = 2) {
  if (!textString || textString.trim() === "") return "";

  // 1. Define common words to ignore (stop words) so they don't skew the scoring
  const stopWords = new Set([
    "the", "a", "an", "and", "but", "or", "for", "nor", "on", "at", 
    "to", "from", "by", "of", "in", "is", "it", "that", "this", "with", "was", "as"
  ]);

  // 2. Clean the text and tokenize into individual words to calculate global frequency
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

  // 3. Split the text into actual sentences
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

  // 5. Sort sentences by score to find the most important ones
  const topSentences = sentenceScores
    .sort((a, b) => b.score - a.score)
    .slice(0, sentenceCount);

  // 6. Re-sort the top sentences back into their original chronological order
  const finalSummary = topSentences
    .sort((a, b) => a.index - b.index)
    .map(s => s.text)
    .join(" ");
  return finalSummary;
}

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
  endpoint.searchParams.set('wait', 'true'); // surface creation failures instead of fire-and-forget
  if (threadId) endpoint.searchParams.set('thread_id', String(threadId));

  let messages = 0;
  for (const [index, batch] of batches.entries()) {
    const payload = compact({
      // Only the first message carries the mention: a batch that had to be split by the
      // character budget must not ping twice.
      content: index === 0 ? content : undefined,
      username: clip(username, 80),
      avatar_url: avatarUrl,
      embeds: batch,
      // Feed content is untrusted input. Default-deny: without this, a title containing
      // @everyone or a role mention would ping the channel. Explicit ids are allowlisted
      // by the caller and nothing else can slip through.
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

      // Discord answers a webhook POST with 204, or 200 when wait=true, so a 202 here is
      // unexpected rather than routine. Retry it, but the exhaustion check is mandatory: the
      // loop is `for (attempt = 0; ; attempt++)` with no bound, so a branch that continues
      // unconditionally spins until the job's timeout-minutes kills the whole run.
      if (res.status === 202) {
        if (attempt >= maxRetries) throw new DiscordError(202, 'accepted with no body, retries exhausted');
        const wait = Math.min(1000 * 2 ** attempt, maxSleepMs);
        log(`  202 Accepted — no body, waiting ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new DiscordError(res.status, await res.text().catch(() => ''));

      messages++;
      // Proactively yield when the bucket is exhausted rather than earning a 429.
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(resetAfter) && resetAfter > 0) await sleep(Math.min(resetAfter * 1000 + 100, maxSleepMs));
      }
      break;
    }
  }

  return { messages, embeds: embeds.length };
}

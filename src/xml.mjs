/**
 * Minimal, tolerant XML reader. No dependencies.
 *
 * This is deliberately NOT a conforming XML parser. Feeds in the wild are sloppy:
 * unescaped ampersands, mismatched close tags, HTML entities that XML never defined,
 * stray DOCTYPEs. A strict parser throws on those; this one keeps going, because a
 * cron job that drops a whole feed over one bad character is worse than one that
 * loses a stray glyph.
 *
 * Node shape: { name, local, attrs, children }
 *   name     raw element name, prefix included ("dc:creator")
 *   local    lowercased local name, prefix stripped ("creator")
 *   attrs    lowercased attribute names -> decoded values (prefixed attrs are also
 *            keyed by local name)
 *   children array of child nodes and raw strings (text)
 */

const NAMED_ENTITIES = new Map(
  Object.entries({
    // The five XML defines.
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    // HTML entities feeds use anyway.
    nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
    bull: '•', prime: '′', Prime: '″', permil: '‰',
    laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
    copy: '©', reg: '®', trade: '™', sect: '§',
    para: '¶', middot: '·', deg: '°', plusmn: '±',
    times: '×', divide: '÷', minus: '−', frac12: '½',
    frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
    euro: '€', pound: '£', yen: '¥', cent: '¢',
    curren: '¤', micro: 'µ', iquest: '¿', iexcl: '¡',
    larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑',
    ne: '≠', le: '≤', ge: '≥', infin: '∞', radic: '√',
    shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
    zwnj: '‌', zwj: '‍',
  })
);

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g;

/** Decode XML/HTML character references. Unknown entities are left verbatim. */
export function decodeEntities(input) {
  const s = String(input);
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff) return match;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return match;
      }
    }
    // Case-sensitive first (&Dagger; !== &dagger;), then case-insensitive.
    if (NAMED_ENTITIES.has(body)) return NAMED_ENTITIES.get(body);
    const lower = body.toLowerCase();
    return NAMED_ENTITIES.has(lower) ? NAMED_ENTITIES.get(lower) : match;
  });
}

const localName = (raw) => {
  const colon = raw.lastIndexOf(':');
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
};

/** Index of the '>' that closes the tag opening at `start`, ignoring '>' inside quotes. */
function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** Skip `<!DOCTYPE ...>` including any internal subset in [ ]. Returns index past it. */
function skipDeclaration(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 2; i < src.length; i++) {
    const c = src[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return src.length;
}

function makeElement(body) {
  const nameMatch = /^([^\s/>]+)/.exec(body);
  const name = nameMatch ? nameMatch[1] : '';
  const node = { name, local: localName(name), attrs: {}, children: [] };
  const rest = nameMatch ? body.slice(nameMatch[0].length) : body;
  const attrRe = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    const key = m[1].toLowerCase();
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if (!(key in node.attrs)) node.attrs[key] = value;
    const short = localName(key);
    if (!(short in node.attrs)) node.attrs[short] = value;
  }
  return node;
}

function addText(node, text, decode) {
  if (text === '') return;
  const value = decode ? decodeEntities(text) : text;
  const last = node.children[node.children.length - 1];
  if (typeof last === 'string') node.children[node.children.length - 1] = last + value;
  else node.children.push(value);
}

/** Pop the stack to the nearest open ancestor with this local name. Unmatched closes are ignored. */
function closeTag(stack, local) {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i].local === local) {
      stack.length = i;
      return;
    }
  }
}

/** Parse XML into a document node. Never throws on malformed input. */
export function parseXml(input) {
  const src = String(input).replace(/^﻿/, '');
  const doc = { name: '#document', local: '#document', attrs: {}, children: [] };
  const stack = [doc];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      addText(stack[stack.length - 1], src.slice(i), true);
      break;
    }
    if (lt > i) addText(stack[stack.length - 1], src.slice(i, lt), true);

    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      addText(stack[stack.length - 1], end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end), false);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src.startsWith('<!', lt)) {
      i = skipDeclaration(src, lt);
    } else if (src.startsWith('</', lt)) {
      const gt = src.indexOf('>', lt + 2);
      const raw = src.slice(lt + 2, gt === -1 ? src.length : gt).trim();
      closeTag(stack, localName(raw));
      i = gt === -1 ? src.length : gt + 1;
    } else {
      const gt = findTagEnd(src, lt);
      if (gt === -1) {
        // Unterminated tag: treat the remainder as text rather than losing the document.
        addText(stack[stack.length - 1], src.slice(lt), true);
        break;
      }
      let body = src.slice(lt + 1, gt);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const node = makeElement(body);
      if (node.name === '') {
        // "< " in running text, not a tag.
        addText(stack[stack.length - 1], src.slice(lt, gt + 1), true);
      } else {
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
      i = gt + 1;
    }
  }
  return doc;
}

/** Element children only, text stripped. */
export function elements(node) {
  return node ? node.children.filter((c) => typeof c !== 'string') : [];
}

export function firstElement(node) {
  return elements(node)[0];
}

/** All element children whose local name matches (case-insensitive). */
export function childrenNamed(node, local) {
  const want = local.toLowerCase();
  return elements(node).filter((c) => c.local === want);
}

/** First child matching any of `locals`, tried in priority order. */
export function pick(node, ...locals) {
  for (const local of locals) {
    const hit = childrenNamed(node, local)[0];
    if (hit) return hit;
  }
  return undefined;
}

/** Concatenated text content, recursive. */
export function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

/** Trimmed text of the first child matching any of `locals`. */
export function textIn(node, ...locals) {
  const hit = pick(node, ...locals);
  return hit ? textOf(hit).trim() : '';
}

export function attr(node, name) {
  if (!node) return undefined;
  const key = name.toLowerCase();
  return node.attrs[key] ?? node.attrs[localName(key)];
}

/** Depth-first search for every element with this local name. */
export function findAllDeep(node, local, out = []) {
  const want = local.toLowerCase();
  for (const child of elements(node)) {
    if (child.local === want) out.push(child);
    findAllDeep(child, want, out);
  }
  return out;
}

/** Strip markup from a description/content blob and collapse it to readable plain text. */
export function stripHtml(html) {
  if (!html) return '';

  const asText = (value) =>
    decodeEntities(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ +([.,;:!?…%)\]}»])/g, '$1')
      .replace(/([(\[{«]) +/g, '$1')
      .trim();

  const withoutLinks = String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, inner) => asText(inner.replace(/<[^<>]+>/g, ' ')))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    // Inline formatting goes WITHOUT a space: "<b>out</b>." must not become "out .".
    .replace(/<\/?(abbr|b|cite|code|del|em|font|i|ins|kbd|mark|q|s|small|span|strong|sub|sup|time|u|var)\b[^<>]*>/gi, '')
    .replace(/<[^<>]*>/g, ' ');

  return asText(withoutLinks);
}

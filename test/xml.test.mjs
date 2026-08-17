import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, childrenNamed, decodeEntities, findAllDeep, firstElement, parseXml, stripHtml, textIn, textOf } from '../src/xml.mjs';

test('decodes named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  assert.equal(decodeEntities('&#65;&#x42;&#x1F600;'), 'AB😀');
  assert.equal(decodeEntities('&mdash;&hellip;&nbsp;'), '—… ');
});

test('leaves unknown and malformed entities verbatim', () => {
  assert.equal(decodeEntities('&notanentity; &#xZZ; & bare'), '&notanentity; &#xZZ; & bare');
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;'); // > U+10FFFF
});

test('is case sensitive for entities that differ only by case', () => {
  assert.equal(decodeEntities('&dagger;&Dagger;'), '†‡');
});

test('parses elements, attributes and nesting', () => {
  const doc = parseXml('<a x="1" y=\'2\'><b>hi</b><c/></a>');
  const a = firstElement(doc);
  assert.equal(a.name, 'a');
  assert.equal(attr(a, 'x'), '1');
  assert.equal(attr(a, 'Y'), '2');
  assert.equal(textIn(a, 'b'), 'hi');
  assert.equal(childrenNamed(a, 'c').length, 1);
});

test('keeps > inside quoted attribute values', () => {
  const doc = parseXml('<a title="1 > 0">x</a>');
  assert.equal(attr(firstElement(doc), 'title'), '1 > 0');
  assert.equal(textOf(firstElement(doc)), 'x');
});

test('exposes namespaced names by prefix and local name', () => {
  const doc = parseXml('<item><dc:creator>Danny</dc:creator></item>');
  assert.equal(textIn(firstElement(doc), 'creator'), 'Danny');
});

test('CDATA is not entity-decoded and survives markup', () => {
  const doc = parseXml('<d><![CDATA[<b>raw &amp; uncut</b>]]></d>');
  assert.equal(textOf(firstElement(doc)), '<b>raw &amp; uncut</b>');
});

test('skips declarations, comments, and DOCTYPEs with internal subsets', () => {
  const doc = parseXml(`<?xml version="1.0"?>
    <!DOCTYPE rss [ <!ENTITY x "y"> ]>
    <!-- a > b -->
    <rss><channel><title>T</title></channel></rss>`);
  const rss = firstElement(doc);
  assert.equal(rss.local, 'rss');
  assert.equal(textIn(childrenNamed(rss, 'channel')[0], 'title'), 'T');
});

test('recovers from mismatched close tags instead of throwing', () => {
  const doc = parseXml('<a><b>one</c><d>two</d></a>');
  const a = firstElement(doc);
  assert.equal(textIn(a, 'b').includes('one'), true);
  assert.equal(findAllDeep(a, 'd').length, 1);
});

test('strips a BOM', () => {
  assert.equal(firstElement(parseXml('﻿<a>x</a>')).local, 'a');
});

test('tolerates an unterminated final tag', () => {
  const doc = parseXml('<a><b>x</b><c');
  assert.equal(textIn(firstElement(doc), 'b'), 'x');
});

test('stripHtml produces readable plain text and double-decodes', () => {
  assert.equal(stripHtml('<p>Hello <b>world</b></p><p>Second</p>'), 'Hello world\n\nSecond');
  assert.equal(stripHtml('a<br>b'), 'a\nb');
  assert.equal(stripHtml('<script>evil()</script>ok'), 'ok');
  // The XML pass decoded &amp;lt;b&amp;gt; to &lt;b&gt;; this pass yields the literal text.
  assert.equal(stripHtml('&lt;b&gt;bold&lt;/b&gt;'), '<b>bold</b>');
  assert.equal(stripHtml('<a href="https://example.com/downloads">View downloads</a>'), '[View downloads](https://example.com/downloads)');
  assert.equal(stripHtml('<p>Read the <a href="https://example.com/releases">View release notes</a>.</p>'), 'Read the [View release notes](https://example.com/releases).');
  assert.equal(stripHtml(''), '');
});

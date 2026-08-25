/**
 * The one failure mode adding a feed can't self-diagnose: a new `webhookEnv` that nobody
 * wired into the workflow's `env:` block. Actions does not inject secrets automatically, so
 * the variable arrives undefined, and the run only fails once there is actually something
 * to post — which may be days later, on a feed you have stopped watching.
 *
 * Parsed with a regex rather than a YAML library on purpose: this project has zero
 * dependencies, and the block is a flat list of `NAME: ${{ secrets.NAME }}` lines.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';

const root = path.join(import.meta.dirname, '..');
const workflowFile = path.join(root, '.github', 'workflows', 'rss-to-discord.yml');

const [config, workflow] = await Promise.all([
  loadConfig(path.join(root, 'feeds.json')),
  readFile(workflowFile, 'utf8'),
]);

/** Every `FOO: ${{ secrets.BAR }}` line in the workflow, as a FOO -> BAR map. */
const injected = new Map(
  [...workflow.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gm)].map((m) => [m[1], m[2]])
);

test('every feed webhookEnv is injected by the workflow', () => {
  const missing = [...new Set(config.feeds.map((f) => f.webhookEnv))].filter((name) => !injected.has(name));
  assert.deepEqual(
    missing,
    [],
    `add to the "Poll feeds" env: block in ${path.relative(root, workflowFile)}:\n` +
      missing.map((n) => `          ${n}: \${{ secrets.${n} }}`).join('\n')
  );
});

test('each injected env var reads the identically named secret', () => {
  // A copy-paste that leaves the old secret name on the right-hand side sends the new feed
  // to the previous feed's channel. Silent, and very confusing from the Discord side.
  for (const [envName, secretName] of injected) {
    assert.equal(secretName, envName, `${envName} is wired to secrets.${secretName}`);
  }
});

test('the workflow does not interpolate dispatch inputs into the shell', () => {
  // `${{ inputs.only }}` inside run: is a shell-injection hole for anyone who can dispatch.
  const runBlocks = [...workflow.matchAll(/run: \|([\s\S]*?)(?=\n {6}- |\n {6}\w+:|$)/g)].map((m) => m[1]);
  for (const block of runBlocks) {
    assert.equal(/\$\{\{\s*inputs\./.test(block), false, 'dispatch inputs must arrive via env:, not interpolation');
  }
});

test('scheduled runs route release and news feeds to separate cadences', () => {
  assert.match(workflow, /SCHEDULE: \$\{\{ github\.event\.schedule \}\}/);
  assert.match(
    workflow,
    /'0,30 16-23 \* \* 1-5'\|'0,30 0 \* \* 2-6'\|'0 1 \* \* 2-6'\)[\s\S]*--only 'apple-releases,apple-releases-beta'/
  );
  assert.match(workflow, /'17 13-23 \* \* \*'|'17 0-2 \* \* \*'\)[\s\S]*--only 'apple-newsroom,apple-dev-news'/);
});

/** The poll job's `steps:` list, one string per step, in declaration order. */
const steps = workflow.split(/\n {6}- (?=uses:|name:)/).slice(1);
const stepWith = (needle) => steps.findIndex((s) => s.includes(needle));

test('the app-token step runs BEFORE checkout', () => {
  // Order is load-bearing and reversing it fails silently: checkout writes whatever token it
  // holds into .git/config as an auth extraheader, and "Persist state" reuses that stored
  // credential. Token step second => the push authenticates as github-actions[bot], which no
  // ruleset bypass list can name. Nothing errors until the push is rejected at the very end.
  const token = stepWith('uses: actions/create-github-app-token');
  const checkout = stepWith('uses: actions/checkout');
  assert.notEqual(token, -1, 'the create-github-app-token step is missing');
  assert.notEqual(checkout, -1, 'the checkout step is missing');
  assert.ok(token < checkout, `move the app-token step above checkout (currently ${token} vs ${checkout})`);
});

test('checkout is handed the app token, under the right step id', () => {
  // A renamed `id:` leaves `steps.<old>.outputs.token` resolving to an empty string, and
  // checkout quietly falls back to GITHUB_TOKEN — same silent rejection as the wrong order.
  const tokenStep = steps.find((s) => s.includes('uses: actions/create-github-app-token'));
  const checkoutStep = steps.find((s) => s.includes('uses: actions/checkout'));
  const id = tokenStep.match(/^\s*id:\s*([\w-]+)/m)?.[1];
  assert.ok(id, 'the app-token step needs an id: so checkout can reference its output');
  const referenced = checkoutStep.match(/token:\s*\$\{\{\s*steps\.([\w-]+)\.outputs\.token\s*\}\}/)?.[1];
  assert.equal(referenced, id, `checkout must read steps.${id}.outputs.token`);
});

test('feed ids map to distinct state files', () => {
  // Two ids that sanitise to one filename would share a cursor and hide each other's items.
  // config.mjs rejects this, but assert it against the committed file too.
  const ids = config.feeds.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate feed ids: ${ids.join(', ')}`);
});

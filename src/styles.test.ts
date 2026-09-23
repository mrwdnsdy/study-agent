/**
 * Guards the design-token blocks at the top of src/styles.css.
 *
 * Run: node --import tsx --test src/styles.test.ts
 *
 * The dark palette is written twice — once under `@media (prefers-color-scheme: dark)`
 * for the OS preference and once under `:root[data-theme="dark"]` for an explicit
 * toggle — because CSS has no way to share a declaration list between the two.
 * These tests keep the two copies from drifting apart and make sure the light
 * `:root` block defines every custom property the dark palette overrides, so no
 * token exists only in dark mode.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** Returns the text inside the balanced `{ … }` block that follows `selector`. */
function blockBody(source: string, selector: RegExp): string {
  const match = selector.exec(source);
  assert.ok(match, `selector not found in styles.css: ${selector}`);
  const open = source.indexOf('{', match.index + match[0].length);
  assert.notEqual(open, -1, `no block follows selector: ${selector}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return assert.fail(`unbalanced block after selector: ${selector}`);
}

/** Strips comments and collapses whitespace so formatting differences do not count. */
function normalise(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((declaration) =>
      declaration
        .replace(/\s+/g, ' ')
        .replace(/\s*:\s*/, ': ')
        .replace(/\s*,\s*/g, ', ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

function customProperties(body: string): string[] {
  return normalise(body)
    .split('\n')
    .map((declaration) => declaration.slice(0, declaration.indexOf(':')).trim())
    .filter((name) => name.startsWith('--'));
}

const light = blockBody(css, /^:root(?=\s*\{)/m);
const darkMedia = blockBody(
  blockBody(css, /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/),
  /:root:not\(\[data-theme=["']light["']\]\)(?=\s*\{)/,
);
const darkAttribute = blockBody(css, /^:root\[data-theme=["']dark["']\](?=\s*\{)/m);

describe('styles.css design tokens', () => {
  test('the light :root block sets a light colour scheme and a palette', () => {
    assert.match(normalise(light), /^color-scheme: light$/m);
    assert.ok(customProperties(light).includes('--bg'));
    assert.ok(customProperties(light).includes('--primary'));
  });

  test('the two dark-palette blocks are identical', () => {
    assert.match(normalise(darkMedia), /^color-scheme: dark$/m);
    assert.ok(customProperties(darkMedia).includes('--bg'), 'dark palette is empty');
    assert.equal(normalise(darkMedia), normalise(darkAttribute));
  });

  test('every dark token is also defined in the light :root block', () => {
    const lightTokens = new Set(customProperties(light));
    const darkOnly = customProperties(darkMedia).filter((name) => !lightTokens.has(name));
    assert.deepEqual(darkOnly, [], 'tokens defined only in dark mode');
  });
});

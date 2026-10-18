import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error a plain .mjs build helper without types
import { weakenSelector, weakenUtilities } from '../scripts/weaken-css.mjs';

test('add-on styles never outrank the POS: every utility selector gets zero specificity (pseudo-elements stay outside)', () => {
  assert.equal(weakenSelector('.flex-col'), ':where(.flex-col)');
  assert.equal(weakenSelector('.a,.b>:not(:last-child)'), ':where(.a),:where(.b>:not(:last-child))');
  assert.equal(weakenSelector('.placeholder\\:x::placeholder'), ':where(.placeholder\\:x)::placeholder');
  const css = '@layer theme{:root{--a:1}}@layer utilities{.flex{display:flex}@media (width>=40rem){.sm\\:grid-cols-3{grid-template-columns:repeat(3,1fr)}}}@keyframes spin{to{transform:rotate(1turn)}}';
  assert.equal(weakenUtilities(css), '@layer theme{:root{--a:1}}@layer utilities{:where(.flex){display:flex}@media (width>=40rem){:where(.sm\\:grid-cols-3){grid-template-columns:repeat(3,1fr)}}}@keyframes spin{to{transform:rotate(1turn)}}');
});

test('the built add-on (npm run build) ships only weakened utilities', { skip: !existsSync(join(import.meta.dirname, '..', '..', 'dist', 'packages', 'ods', 'ui.js')) && 'run npm run build first' }, () => {
  const ui = readFileSync(join(import.meta.dirname, '..', '..', 'dist', 'packages', 'ods', 'ui.js'), 'utf8');
  const at = ui.indexOf('@layer utilities{');
  assert.ok(at > 0, 'the add-on carries its utilities');
  assert.match(ui.slice(at, at + 200), /^@layer utilities\{:where\(/);
  assert.ok(!/@layer utilities\{\.flex-col\{/.test(ui) && !/\}\.flex-col\{/.test(ui.slice(at)), 'no plain .flex-col rule that could override POS layouts');
});

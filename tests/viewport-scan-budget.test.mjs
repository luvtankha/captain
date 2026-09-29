import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('  function sensitiveTextRegions('), source.indexOf('  function visible(el)'));
function scanner(nodes = [], styled = []) {
  let index = 0;
  const rect = { x: 10, y: 10, width: 100, height: 20 };
  const root = { createTreeWalker: () => ({ nextNode: () => nodes[index++] }),
    querySelectorAll: selector => selector === 'body *,*' ? styled : [] };
  const scope = { document: root, NodeFilter: { SHOW_TEXT: 4 },
    Range: class { setStart() {} setEnd() {} getClientRects() { return [rect]; } },
    PRIVATE_OBSERVATION_ERROR: 'withheld', visible: el => el.shown !== false,
    topRect: () => rect, textFindings: value => value.includes('@') ? [{ kind: 'EMAIL', index: 0, length: value.length }] : [],
    getComputedStyle: () => ({ backgroundImage: 'none', content: 'none' }) };
  vm.runInNewContext(functions, scope);
  return scope;
}
const node = (value, shown = true) => ({ nodeValue: value, parentElement: { tagName: 'P', shown } });

test('whitespace and offscreen text do not consume the visible privacy budget', () => {
  const s = scanner([...Array.from({ length: 1700 }, () => node(' ')), ...Array.from({ length: 500 }, () => node('offscreen', false)), node('private@example.test')]);
  assert.equal(s.sensitiveTextRegions(undefined, true)[0].kind, 'EMAIL');
});
test('text traversal and visible-content overflow still fail closed', () => {
  assert.throws(() => scanner(Array.from({ length: 20001 }, () => node(' '))).sensitiveTextRegions(undefined, true), /withheld/);
  assert.throws(() => scanner(Array.from({ length: 1601 }, () => node('public'))).sensitiveTextRegions(undefined, true), /withheld/);
});
test('offscreen styled elements do not consume viewport inspection budget', () => {
  const s = scanner([], [...Array.from({ length: 3000 }, () => ({ shown: false })), { shown: true }]);
  assert.equal(s.uninspectableVisualRegions(undefined, true).length, 0);
});
test('style traversal and visible-style overflow still fail closed', () => {
  assert.throws(() => scanner([], Array.from({ length: 20001 }, () => ({ shown: false }))).uninspectableVisualRegions(undefined, true), /withheld/);
  assert.throws(() => scanner([], Array.from({ length: 2501 }, () => ({ shown: true }))).uninspectableVisualRegions(undefined, true), /withheld/);
});

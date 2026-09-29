import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const content = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
const functionSource = content.slice(content.indexOf('  function safeNavigationHref('), content.indexOf('  function sensitiveTextRegions('));
function helper() {
  const sanitized = [];
  const scope = { URL, textFindings: value => value.includes('private') ? [{ kind: 'UNKNOWN' }] : [],
    redact: value => { sanitized.push(value); return { text: value }; } };
  vm.runInNewContext(functionSource, scope);
  return { href: scope.safeNavigationHref, sanitized };
}
test('unknown and encoded private optional links are omitted before session sanitization', () => {
  const { href, sanitized } = helper();
  assert.equal(href('https://example.test/private'), '');
  assert.equal(href('https://example.test/%70rivate'), '');
  assert.equal(sanitized.length, 0);
});
test('links omit credentials, scripts, malformed encoding, query and fragment', () => {
  const { href, sanitized } = helper();
  for (const url of ['javascript:alert(1)', 'data:text/plain,test', 'https://u:p@example.test/', 'https://example.test/%zz']) assert.equal(href(url), '');
  assert.equal(href('https://example.test/public?token=private#private'), 'https://example.test/public');
  assert.deepEqual(sanitized, ['https://example.test/public']);
});

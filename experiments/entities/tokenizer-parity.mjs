import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { AutoTokenizer, env } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
const root = fileURLToPath(new URL('./assets/', import.meta.url));
const code = await readFile(new URL('../../extension/entities/wordpiece.js', import.meta.url), 'utf8');
const ctx = {};
ctx.globalThis = ctx;
vm.runInNewContext(code, ctx);
const ours = ctx.CaptainAlternativeWordPiece.create(await readFile(new URL('./assets/vocab.txt', import.meta.url), 'utf8'));
const reference = await AutoTokenizer.from_pretrained(root, { local_files_only: true });

const corpus = [
  ['Contact', 'Jane', 'Doe', 'at', 'jane.doe@example.com.'],
  ['Call', '555-123-4567', 'or', 'email', 'support@example.org'],
  ['SSN:', '123-45-6789', '|', 'IP:', '10.0.0.1'],
  ['Ordinary', 'text', 'on', 'a', 'web', 'page.'],
  ['hello-world', 'US_BANK_NUMBER', 'http://site.example/path?q=1'],
  ['<div>', 'token', 'sk_test_0123456789', '</div>'],
];
for (const words of corpus) {
  const actual = ours.encodeWords(words.map(text => ({ text })));
  const expected = await reference(words.join(' '), { add_special_tokens: true, truncation: false });
  assert.deepEqual(Array.from(actual.ids), Array.from(expected.input_ids.data, Number),
    'Pinned WordPiece encoding must match original tokenizer exactly.');
  assert.equal(actual.tokenToWord.length, actual.ids.length);
  assert.equal(actual.tokenToWord[0], -1);
  assert.equal(actual.tokenToWord.at(-1), -1);
}
for (const unsafe of ['हैलो', '', '\x00control', 'x'.repeat(129), '🙃']) {
  assert.throws(() => ours.encodeWords([{ text: unsafe }]));
}
assert.throws(() => ours.encodeWords(Array.from({ length: 600 }, () => ({ text: 'wordpiece' }))));
console.log(JSON.stringify({ passed: true, corpusCases: corpus.length, unsupportedCases: 5,
  reference: 'local pinned original tokenizer', offline: true }));

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { scanText, redactText, payloadLeaks } from '../server/privacy.mjs';

const source = await readFile(new URL('../extension/privacy/privacy-core.js', import.meta.url), 'utf8');
function freshCore() {
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  return sandbox.CAPTAIN_PRIVACY;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('one classic script works in an isolated browser VM and exposes no mapping or raw-value API', () => {
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  const core = freshCore();
  assert.deepEqual(Object.keys(core), ['scanSpans', 'createSession']);
  const session = core.createSession();
  assert.deepEqual(Object.keys(session), ['sanitizeText', 'clear']);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(Object.isFrozen(session), true);
  const result = session.sanitizeText('person@example.test');
  assert.deepEqual(plain(result), { text: '[EMAIL_1]', found: ['EMAIL'], blocked: false });
  assert.equal(JSON.stringify(core).includes('person@example.test'), false);
  assert.equal(JSON.stringify(session).includes('person@example.test'), false);
});

test('scanner uses global exclusive character offsets, stable ordering and merged overlapping spans', () => {
  const core = freshCore();
  const value = '🔒 https://example.test/?token=person@example.test and +91 9876543210';
  const spans = plain(core.scanSpans(value));
  assert.deepEqual(spans.map(({ type }) => type), ['TOKEN', 'PHONE']);
  assert.equal(value.slice(spans[0].start, spans[0].end), 'person@example.test');
  assert.equal(value.slice(spans[1].start, spans[1].end), '+91 9876543210');
  assert.equal(spans[0].start, value.indexOf('person@example.test'));
  assert.equal(spans[1].start, value.indexOf('+91'));
  assert.ok(spans.every(({ start, end }) => start < end && end <= value.length));
});

test('verified Indian Aadhaar check digit and conservative invalid-ID fallback', () => {
  const core = freshCore();
  assert.deepEqual(plain(core.scanSpans('2341 2341 2346')).map(s => s.type), ['AADHAAR']);
  assert.deepEqual(plain(core.scanSpans('2341.2341.2346')).map(s => s.type), ['AADHAAR']);
  assert.deepEqual(plain(core.scanSpans('2341 2341 2347')).map(s => s.type), ['ACCOUNT']);
  assert.deepEqual(plain(core.scanSpans('1234 5678 9012')).map(s => s.type), ['ACCOUNT']);
  const output = core.createSession().sanitizeText('a 2341 2341 2346 b 1234 5678 9012');
  assert.equal(output.text.includes('2341'), false);
  assert.equal(output.text.includes('5678'), false);
});

test('PAN, Indian phone and Luhn card cover grouped delimiters without leaving suffixes', () => {
  const core = freshCore();
  const input = 'PAN ABCDE1234F; phone +91-98765-43210; card 4111-1111-1111-1111; alt 4111111111111112';
  const spans = plain(core.scanSpans(input));
  assert.deepEqual(spans.map(s => s.type), ['PAN', 'PHONE', 'CARD', 'ACCOUNT']);
  const result = core.createSession().sanitizeText(input);
  for (const original of ['ABCDE1234F', '98765', '4111', '1112']) assert.equal(result.text.includes(original), false);
  assert.match(result.text, /\[PAN_1\]/);
  assert.match(result.text, /\[PHONE_1\]/);
  assert.match(result.text, /\[CARD_1\]/);
  const slashCard = core.createSession().sanitizeText('4111/1111/1111/1111');
  assert.equal(slashCard.text, '[CARD_1]');
});

test('secret, URL, bearer, encoded query and credential labels mask complete values', () => {
  const core = freshCore();
  const samples = [
    ['password: correct horse battery staple', 'PASSWORD'],
    ['token=privatePart0123456789', 'TOKEN'],
    ['https://fixture.test/?access%5Ftoken=part%2Fsecret%3Dxyz', 'TOKEN'],
    ['https%3A%2F%2Ffixture.test%2F%3Ftoken%3Dabc%2Bsecret%26safe%3D1', 'UNKNOWN'],
    ['Bearer short-secreT.1234', 'TOKEN'],
    ['api key: test_fixture_Abc123_DEF456', 'API_KEY'],
    ['https://user:testpass@fixture.test/dashboard', 'CREDENTIAL'],
    ['OTP: 004210', 'OTP'],
    ['PIN: 0000', 'PIN'],
    ['account number: 123-456-789', 'ACCOUNT']
  ];
  for (const [sample, type] of samples) {
    const output = core.createSession().sanitizeText(sample);
    assert.equal(output.found.includes(type), true, sample.slice(0, 12));
    assert.equal(output.text.includes(type === 'PASSWORD' ? 'horse battery' : type === 'OTP' ? '004210' : type === 'PIN' ? '0000' : 'privatePart0123456789'), false);
    assert.equal(payloadLeaks({ context: { title: output.text } }).length, 0);
  }
  const labeled = core.createSession().sanitizeText('password: correct horse battery staple');
  assert.equal(labeled.text, 'password: [PASSWORD_1]');
  const longValue = 'fixture' + 'x'.repeat(700);
  assert.equal(core.createSession().sanitizeText('password: ' + longValue).text, 'password: [PASSWORD_1]');
  assert.equal(core.createSession().sanitizeText('https://fixture.test/?token=' + longValue).text, 'https://fixture.test/?token=[TOKEN_1]');
});

test('semantic person and address fields plus explicit sensitive kinds use separate typed placeholders', () => {
  const core = freshCore(), session = core.createSession();
  const output = session.sanitizeText('Name: Ada Example; Address: 42 Mock Road; Email: ada@example.test');
  assert.equal(output.text, 'Name: [PERSON_1]; Address: [ADDRESS_1]; Email: [EMAIL_1]');
  assert.deepEqual(plain(output.found), ['PERSON', 'ADDRESS', 'EMAIL']);
  assert.equal(session.sanitizeText('sample local secret', { kind: 'password' }).text, '[PASSWORD_1]');
  assert.equal(session.sanitizeText('sample local secret', { kind: 'security-answer' }).text, '[CREDENTIAL_1]');
  assert.equal(session.sanitizeText('Ada Example', { kind: 'full-name' }).text, '[PERSON_1]');
});

test('per-session repeated values remain stable; clear destroys mapping and resets counters', () => {
  const core = freshCore(), one = core.createSession(), two = core.createSession();
  assert.equal(one.sanitizeText('first@example.test').text, '[EMAIL_1]');
  assert.equal(one.sanitizeText('second@example.test').text, '[EMAIL_2]');
  assert.equal(one.sanitizeText('first@example.test').text, '[EMAIL_1]');
  assert.equal(two.sanitizeText('second@example.test').text, '[EMAIL_1]');
  assert.equal(one.sanitizeText('[EMAIL_1]').text, '[EMAIL_1]');
  assert.equal(one.sanitizeText('[REDACTED_SECRET]').text, '[REDACTED_SECRET]');
  one.clear();
  assert.equal(one.sanitizeText('second@example.test').text, '[EMAIL_1]');
});

test('unknown opaque text blocks by default or is fully redacted on explicit policy', () => {
  const core = freshCore();
  const opaque = 'Abc1234567890_def_9876543210_opaque';
  const blocked = core.createSession().sanitizeText('public ' + opaque + ' suffix');
  assert.deepEqual(plain(blocked), { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true });
  const masked = core.createSession().sanitizeText('public ' + opaque + ' suffix', { unknownPolicy: 'redact' });
  assert.equal(masked.text, 'public [UNKNOWN_1] suffix');
  assert.equal(masked.blocked, false);
  assert.equal(masked.text.includes(opaque), false);
});

test('synthetic canaries and PEM private key blocks are entire critical spans', () => {
  const core = freshCore();
  for (const sensitive of [
    'CANARY_FIXTURE_ACCOUNT_A123',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-fixture-only-key\n-----END PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-not-a-key\n-----END OPENSSH PRIVATE KEY-----'
  ]) {
    const result = core.createSession().sanitizeText(sensitive);
    assert.deepEqual(plain(result.found), ['CREDENTIAL']);
    assert.equal(result.text, '[CREDENTIAL_1]');
    assert.equal(payloadLeaks({ context: { title: sensitive } }).length > 0, true);
  }
});

test('bounded input and candidate overflow fail closed without echoing raw values', () => {
  const core = freshCore(), session = core.createSession();
  const tooLong = 'Z'.repeat(16_385);
  assert.deepEqual(plain(session.sanitizeText(tooLong)), { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true });
  const tooMany = Array.from({ length: 300 }, (_, n) => 'p' + n + '@fixture.test').join(' ');
  assert.deepEqual(plain(session.sanitizeText(tooMany)), { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true });
  assert.equal(session.sanitizeText(32).blocked, true);
  assert.equal(session.sanitizeText('x', { kind: 'unrecognized-private-field' }).blocked, true);
  assert.equal(session.sanitizeText('x', { unknownPolicy: 'allow' }).blocked, true);
  const badOption = Object.defineProperty({}, 'kind', { get() { throw new Error('raw fixture must stay private'); } });
  assert.deepEqual(plain(session.sanitizeText('x', badOption)), { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true });
});

test('legacy server scanner and redact functions use the same shared detection policy', () => {
  const value = 'person@example.test; PAN ABCDE1234F; card 4111 1111 1111 1111';
  const scanner = plain(freshCore().scanSpans(value));
  assert.deepEqual(scanText(value), scanner.map(s => ({ kind: s.type.toLowerCase(), index: s.start, length: s.end - s.start })));
  const output = redactText(value);
  assert.deepEqual(output.counts, { email: 1, pan: 1, card: 1 });
  assert.equal(output.text.includes('person@example.test'), false);
  assert.deepEqual(payloadLeaks({ task: output.text }), []);
});

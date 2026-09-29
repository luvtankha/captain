import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness() {
  const nodes = new Map(), messages = [], intervals = [];
  const state = { build: '0.5.0', status: 'idle' };
  let change, receive;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', disabled: false, hidden: false,
      classList: { toggle() {} }, addEventListener(name, fn) { this[name] = fn; }, focus() { this.focused = true; } });
    return nodes.get(id);
  };
  const sandbox = {
    URL, console, setInterval: fn => intervals.push(fn),
    location: { href: 'chrome-extension://captain/popup.html?window=3' },
    document: { hidden: false, querySelector: node, addEventListener() {} },
    runLocalVision: async () => ({ screenshot: 'masked-only' }),
    chrome: {
      storage: { onChanged: { addListener(fn) { change = fn; } } },
      runtime: {
        onMessage: { addListener(fn) { receive = fn; } }, openOptionsPage() {},
        async sendMessage(message) {
          messages.push(message);
          if (message.type === 'GET_STATE') return { ...state };
          if (message.type === 'START_TASK') { state.status = 'running'; state.requestId = message.requestId; }
          if (message.type === 'CANCEL_TASK') state.status = 'error';
          return { ok: true };
        }
      }
    }
  };
  vm.runInNewContext(code, sandbox);
  return { node, state, messages, sandbox, intervals, changed: () => change({ captainState: {} }, 'local'),
    receive: message => new Promise(resolve => receive(message, {}, resolve)) };
}

test('text controller submits once, locks execution and consent, then accepts the next command', async () => {
  const h = harness(); await flush();
  h.node('#task').value = '  open github.com/login  ';
  await Promise.all([h.node('#run').onclick(), h.node('#run').onclick()]);
  let sent = h.messages.filter(m => m.type === 'START_TASK');
  assert.equal(sent.length, 1); assert.equal(sent[0].task, 'open github.com/login');
  assert.match(sent[0].requestId, /^text-/);
  h.state.status = 'waiting_privacy_consent'; h.changed(); await flush();
  assert.equal(h.node('#run').disabled, true);
  assert.equal(h.node('#phase').textContent, 'Permission required');
  await h.node('#run').onclick();
  assert.equal(h.messages.filter(m => m.type === 'START_TASK').length, 1);
  h.state.status = 'complete'; h.changed(); await flush();
  assert.equal(h.node('#run').disabled, false);
  h.node('#task').value = 'open wikipedia.org'; await h.node('#run').onclick();
  assert.equal(h.messages.filter(m => m.type === 'START_TASK').length, 2);
});

test('Enter submits text; Shift+Enter, composition, and empty commands do not', async () => {
  const h = harness(); await flush();
  h.node('#task').value = 'open example.com';
  for (const extra of [{ shiftKey: true }, { isComposing: true }]) {
    h.node('#task').keydown({ key: 'Enter', ...extra, preventDefault() { throw new Error('Must preserve editing'); } });
  }
  assert.equal(h.messages.filter(m => m.type === 'START_TASK').length, 0);
  h.node('#task').keydown({ key: 'Enter', preventDefault() {} }); await flush();
  assert.equal(h.messages.filter(m => m.type === 'START_TASK').length, 1);
  h.state.status = 'complete'; h.changed(); await flush();
  h.node('#task').value = ' '; await h.node('#run').onclick();
  assert.equal(h.node('#task').focused, true);
});

test('hidden controller skips polling; protected-input message and local visual processing remain available', async () => {
  const h = harness(); await flush();
  h.sandbox.document.hidden = true;
  const count = h.messages.length;
  for (const fn of h.intervals) await fn();
  assert.equal(h.messages.length, count);
  assert.equal((await h.receive({ type: 'VISION_REDACT', windowId: 3 })).screenshot, 'masked-only');
  h.sandbox.document.hidden = false;
  h.state.status = 'complete'; h.state.phase = 'SENSITIVE_ACCESS_REQUIRED';
  h.changed(); await flush();
  assert.equal(h.node('#message').textContent, 'the site does not allow entry without information access please tell me what to do further ?');
});

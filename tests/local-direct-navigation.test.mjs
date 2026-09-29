import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');

function parser() {
  const sandbox = {
    URL,
    chrome: { runtime: { onMessage: { addListener() {} } } },
  };
  vm.runInNewContext(source, sandbox, { filename: 'service-worker.js' });
  return task => JSON.parse(JSON.stringify(sandbox.localDirectNavigation(task)));
}

test('explicit typed site commands navigate locally before planning', () => {
  const localNavigation = parser();
  assert.deepEqual(localNavigation('Hey Captain, open GitHub'), {
    url: 'https://github.com', source: 'named-site',
  });
  assert.deepEqual(localNavigation('please navigate to git hub website'), {
    url: 'https://github.com', source: 'named-site',
  });
  assert.deepEqual(localNavigation('Open example dot com/docs?tab=one'), {
    url: 'https://example.com/docs?tab=one', source: 'explicit-url',
  });
});

test('local direct navigation does not guess brands or accept executable URLs', () => {
  const localNavigation = parser();
  for (const command of [
    'open a made up brand',
    'open GitHub and then search for issues',
    'search for GitHub and open it',
    'open javascript:alert(1)',
    'open https://user:pass@example.com/',
    'open data:text/html,hello',
  ]) assert.equal(localNavigation(command), null, command);
});

test('the direct navigation precedes the first protected-page observation', () => {
  const parse = source.indexOf('const directNavigation = localDirectNavigation(task);');
  const navigate = source.indexOf('const navigation = await navigateSameTab(tab.id, directNavigation.url);');
  const ready = source.indexOf('const readiness = await waitForPrivacyScanReady(tab);');
  const observe = source.indexOf('let context = await observeStable(tab, observationConfig);');
  assert.ok(parse >= 0 && navigate > parse && ready > navigate && observe > ready,
    'explicit navigation must settle the local privacy engine before CAPTAIN captures or scans a page');
});

test('direct live-page scanning waits for a readable page plus one fixed-shape local visual-stability sample', async () => {
  const messages = [];
  const readiness = {
    url: 'https://github.com/', documentReadyState: 'complete',
    documentToken: 'local-document-1', domRevision: 2, geometryRevision: 3,
    ready: true, meaningfulContent: true, amazonResultCards: 0,
  };
  const stability = {
    ok: true, url: 'https://github.com/', documentToken: 'local-document-1', domRevision: 2, geometryRevision: 3,
    redactionCount: 0, redactionDigest: 'a1b2c3d4', visibleTextDigest: 'b1c2d3e4', controlDigest: 'c1d2e3f4',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  };
  const sandbox = {
    URL, Date, setTimeout, clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: {
        get: async () => ({ id: 9, incognito: false, status: 'complete', url: 'https://github.com/' }),
        sendMessage: async (_id, message) => {
          messages.push(message);
          return message.type === 'READINESS' ? readiness : stability;
        },
      },
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'service-worker.js' });
  const result = await sandbox.waitForPrivacyScanReady({ id: 9 }, { timeoutMs: 1000, sampleDelayMs: 0 });
  assert.equal(result.ready, true);
  assert.equal(JSON.stringify(messages), JSON.stringify([{ type: 'READINESS' }, { type: 'VISUAL_STABILITY' }]));
});

test('an incomplete local visual-stability sample delays capture until the current page reports a complete sample', async () => {
  let reads = 0;
  const sandbox = {
    URL, Date, setTimeout, clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: {
        get: async () => ({ id: 9, incognito: false, status: 'complete', url: 'https://github.com/' }),
        sendMessage: async (_id, message) => {
          reads++;
          if (message.type === 'VISUAL_STABILITY' && reads === 2) return { ok: false };
          if (message.type === 'VISUAL_STABILITY') return {
            ok: true, url: 'https://github.com/', documentToken: 'local-document-1', domRevision: 2, geometryRevision: 2,
            redactionCount: 0, redactionDigest: 'a1b2c3d4', visibleTextDigest: 'b1c2d3e4', controlDigest: 'c1d2e3f4',
            viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
          };
          return {
            url: 'https://github.com/', documentReadyState: 'complete',
            documentToken: 'local-document-1', domRevision: 2, geometryRevision: 2,
            ready: true, meaningfulContent: true, amazonResultCards: 0,
          };
        },
      },
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'service-worker.js' });
  await sandbox.waitForPrivacyScanReady({ id: 9 }, { timeoutMs: 1000, sampleDelayMs: 0 });
  assert.equal(reads, 4, 'the incomplete visual sample must not authorize capture');
});

test('committed streaming pages can establish privacy readiness without all resources finishing', async () => {
  let reads = 0;
  const sandbox = { URL, Date, setTimeout, clearTimeout, chrome: {
    runtime: { onMessage: { addListener() {} } }, tabs: {
      get: async () => ({ id: 9, incognito: false, status: 'loading', url: 'https://example.org/questions' }),
      sendMessage: async (_id, message) => { reads++;
        if (message.type === 'VISUAL_STABILITY') return { ok: true, url: 'https://example.org/questions',
          documentToken: 'new-document', domRevision: 1, geometryRevision: 1,
          redactionCount: 0, redactionDigest: 'a1b2c3d4', visibleTextDigest: 'b1c2d3e4', controlDigest: 'c1d2e3f4',
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 } };
        return { url: 'https://example.org/questions',
        documentReadyState: 'interactive', documentToken: 'new-document', domRevision: 1,
        geometryRevision: 1, ready: true, meaningfulContent: true }; }
    }
  } };
  vm.runInNewContext(source, sandbox);
  assert.equal((await sandbox.waitForPrivacyScanReady({ id: 9 }, { timeoutMs: 500, sampleDelayMs: 0 })).ready, true);
  assert.equal(reads, 2);
});

test('pending navigation never establishes privacy readiness from the old document', async () => {
  let reads = 0;
  const sandbox = { URL, Date, setTimeout, clearTimeout, chrome: {
    runtime: { onMessage: { addListener() {} } }, tabs: {
      get: async () => ({ id: 9, incognito: false, status: 'loading', url: 'https://old.example/', pendingUrl: 'https://new.example/' }),
      sendMessage: async () => { reads++; }
    }
  } };
  vm.runInNewContext(source, sandbox);
  await assert.rejects(sandbox.waitForPrivacyScanReady({ id: 9 }, { timeoutMs: 20, sampleDelayMs: 0 }), /screenshot withheld/);
  assert.equal(reads, 0);
});

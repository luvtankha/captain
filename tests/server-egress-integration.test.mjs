import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planStep } from '../server/planner.mjs';

const MODEL_SHA256 = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const context = () => ({
  url: 'https://example.test/catalog', title: 'Catalog', pageText: 'Visible product catalog',
  elements: [{ ref: 'c1', tag: 'button', role: 'button', name: 'Products',
    value: '', href: '', sensitive: false, disabled: false, confidence: 1,
    bbox: { x: 1, y: 1, width: 90, height: 30 }, state: {}, source: 'dom' }],
});
const modelReply = { action: { type: 'finish', message: 'Review the visible page.' }, reason: 'Model response' };

test('fully masked visual evidence blocks model guessing while deterministic navigation remains available', async () => {
  const bytes = Buffer.alloc(120, 7);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  bytes[118] = 0xff; bytes[119] = 0xd9;
  const page = context();
  page.screenshot = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  page.visualPrivacy = {
    schema: 'captain.visual-privacy.v2', sanitized: true, rawScreenshotTransmitted: false,
    redactionApplied: true, domBoxes: 1, faces: 0, outputBytes: bytes.length,
    inferenceMs: 10, totalMs: 20, faceModel: 'ultraface-rfb-320',
    modelSha256: MODEL_SHA256, imageSha256: createHash('sha256').update(bytes).digest('hex'),
    maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: 1,
    fullBlackout: true, input: { width: 640, height: 480 }
  };
  for (const config of [
    { CAPTAIN_OLLAMA_MODEL: 'synthetic', CAPTAIN_OLLAMA_VISION: 'true' },
    { CAPTAIN_VLM_BASE_URL: 'https://model.example.test', CAPTAIN_VLM_API_KEY: 'synthetic-test-only' }
  ]) await withMockedProvider(config, async calls => {
    const plan = await planStep('Use the screenshot to choose the green control', page, []);
    assert.equal(plan.action.type, 'finish');
    assert.equal(plan.action.completionStatus, 'BLOCKED');
    assert.ok(plan.action.clarification);
    assert.equal(calls.length, 0, 'No image or model request is needed without visual evidence.');
    assert.equal((await planStep('open YouTube', page, [])).action.type, 'navigate');
    assert.equal(calls.length, 0);
  });
});

async function withMockedProvider(configuration, work, providerMessage = { content: JSON.stringify(modelReply) }) {
  const keys = ['CAPTAIN_OLLAMA_MODEL', 'CAPTAIN_OLLAMA_VISION', 'CAPTAIN_VLM_BASE_URL', 'CAPTAIN_VLM_API_KEY', 'CAPTAIN_VLM_MODEL'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, configuration);
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options, payload: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(modelReply) } }],
          message: providerMessage,
        }),
      };
    };
    await work(calls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('deterministic plan stays local even when a remote provider is configured', async () => {
  await withMockedProvider({ CAPTAIN_VLM_BASE_URL: 'https://model.example.test', CAPTAIN_VLM_API_KEY: 'synthetic-test-only' }, async calls => {
    const plan = await planStep('open YouTube', { url: 'about:blank', title: 'New browser tab', elements: [] }, []);
    assert.equal(plan.action.type, 'navigate');
    assert.equal(plan.planner, 'fast-command');
    assert.equal(calls.length, 0);
  });
});

test('direct remote VLM egress uses only strict validated context/history', async () => {
  await withMockedProvider({ CAPTAIN_VLM_BASE_URL: 'https://model.example.test', CAPTAIN_VLM_API_KEY: 'synthetic-test-only' }, async calls => {
    const plan = await planStep('analyze visible page layout', context(), [{ action: { type: 'wait' }, result: { ok: true } }]);
    assert.equal(plan.planner, 'remote-vlm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://model.example.test/chat/completions');
    const content = JSON.parse(calls[0].payload.messages[1].content);
    assert.equal(content.context.url, 'https://example.test/catalog');
    assert.equal(content.context.elements[0].ref, 'c1');
    assert.deepEqual(content.history, [{ action: { type: 'wait' }, result: { ok: true } }]);
    assert.equal(calls[0].payload.messages[1].content.includes('undefined'), false);
  });
});

test('unrecognized nested data, private URL and canary reject before either provider fetch', async () => {
  for (const configuration of [
    { CAPTAIN_VLM_BASE_URL: 'https://model.example.test', CAPTAIN_VLM_API_KEY: 'synthetic-test-only' },
    { CAPTAIN_OLLAMA_MODEL: 'synthetic-test-model' },
  ]) {
    await withMockedProvider(configuration, async calls => {
      for (const altered of [
        { ...context(), storage: { token: 'private-canary' } },
        { ...context(), url: 'https://example.test/catalog?secret=private-canary' },
        { ...context(), elements: [{ ...context().elements[0], name: 'CANARY_PRIVATE' }] },
      ]) {
        await assert.rejects(planStep('analyze visible page layout', altered, []), error => {
          assert.equal(error.code, 'CAPTAIN_OUTBOUND_CONTRACT');
          assert.doesNotMatch(error.message, /private-canary|CANARY_PRIVATE/);
          return true;
        });
      }
      assert.equal(calls.length, 0);
    });
  }
});

test('remote VLM sends only native opaque-coverage v2 JPEG and no raw worker fields', async () => {
  const bytes = Buffer.alloc(120, 7);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  bytes[118] = 0xff; bytes[119] = 0xd9;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const page = context();
  page.screenshot = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  page.visualPrivacy = {
    schema: 'captain.visual-privacy.v2', sanitized: true, rawScreenshotTransmitted: false,
    redactionApplied: true, domBoxes: 1, faces: 1, outputBytes: bytes.length,
    inferenceMs: 10, totalMs: 20, faceModel: 'ultraface-rfb-320',
    modelSha256: MODEL_SHA256, imageSha256: digest,
    maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: 2,
    input: { width: 640, height: 480 },
  };
  await withMockedProvider({ CAPTAIN_VLM_BASE_URL: 'https://model.example.test', CAPTAIN_VLM_API_KEY: 'synthetic-test-only' }, async calls => {
    assert.equal((await planStep('analyze visible page layout', page, [])).planner, 'remote-vlm');
    assert.equal(calls.length, 1);
    const content = calls[0].payload.messages[1].content;
    assert.equal(Array.isArray(content), true);
    assert.equal(content[1].image_url.url, page.screenshot);
    const body = JSON.parse(content[0].text);
    assert.equal(body.context.visualPrivacy.schema, 'captain.visual-privacy.v2');
    assert.equal(body.context.visualPrivacy.coverageVerified, true);
    assert.equal(body.context.visualPrivacy.maskPolicy, 'opaque-raster-v1');
    assert.equal(body.context.screenshot, undefined);
    assert.equal(body.context.visualPrivacy.input.width, 640);
    assert.equal(body.context.visualPrivacy.workerJsHeapBytes, undefined);
  });
});

test('Ollama local model receives sanitized text only, with no model call on malformed history', async () => {
  await withMockedProvider({ CAPTAIN_OLLAMA_MODEL: 'synthetic-test-model', CAPTAIN_OLLAMA_VISION: 'false' }, async calls => {
    assert.equal((await planStep('analyze visible page layout', context(), [])).planner, 'ollama');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
    const message = calls[0].payload.messages[1].content;
    const parsed = JSON.parse(message);
    assert.equal(parsed.context.url, 'https://example.test/catalog');
    assert.equal(parsed.context.screenshot, undefined);
    await assert.rejects(planStep('analyze visible page layout', context(), [
      { action: { type: 'navigate', url: 'https://example.test/?secret=private-canary' }, result: { ok: true } },
    ]), { code: 'CAPTAIN_OUTBOUND_CONTRACT' });
    assert.equal(calls.length, 1);
  });
});

test('approved local visual planner receives proof-bound image and observed control refs only', async () => {
  const bytes = Buffer.alloc(120, 7);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  bytes[118] = 0xff; bytes[119] = 0xd9;
  const page = context();
  page.screenshot = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  page.visualPrivacy = {
    schema: 'captain.visual-privacy.v2', sanitized: true, rawScreenshotTransmitted: false,
    redactionApplied: true, domBoxes: 2, faces: 1, outputBytes: bytes.length,
    inferenceMs: 10, totalMs: 20, faceModel: 'ultraface-rfb-320',
    modelSha256: MODEL_SHA256,
    imageSha256: createHash('sha256').update(bytes).digest('hex'),
    maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: 2,
    input: { width: 640, height: 480 },
  };
  await withMockedProvider({ CAPTAIN_OLLAMA_MODEL: 'synthetic-test-model', CAPTAIN_OLLAMA_VISION: 'true' }, async calls => {
    assert.equal((await planStep('choose the green control in the masked image', page, [])).planner, 'ollama');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(calls[0].payload.think, false);
    assert.equal(calls[0].payload.format, 'json');
    assert.equal(calls[0].payload.options.num_predict, 2048);
    assert.equal(calls[0].payload.messages[0].images[0], page.screenshot.split(',')[1]);
    const instruction = calls[0].payload.messages[0].content;
    assert.ok(instruction.endsWith('\n/no_think'));
    assert.deepEqual(calls[0].payload.messages[1], { role: 'assistant', content: '<think></think>' });
    const input = JSON.parse(instruction.split('INPUT:\n')[1].replace(/\n\/no_think$/, ''));
    assert.equal(input.context.screenshot, undefined);
    assert.equal(input.context.elements[0].ref, 'c1');
    assert.deepEqual(input.context.elements[0].bbox, page.elements[0].bbox);
    assert.equal(input.context.visualPrivacy.schema, 'captain.visual-privacy.v2');
    assert.equal(input.context.visualPrivacy.coverageVerified, true);
    assert.equal(input.context.visualPrivacy.modelSha256, MODEL_SHA256);
    assert.equal(input.context.elements[0].source, 'dom');
    assert.equal(input.context.elements[0].confidence, 1);
  });
});

test('approved local model cannot turn reasoning-only or missing final content into an action', async () => {
  await withMockedProvider({ CAPTAIN_OLLAMA_MODEL: 'synthetic-test-model', CAPTAIN_OLLAMA_VISION: 'false' }, async calls => {
    await assert.rejects(planStep('analyze visible page layout', context(), []), /no structured action/i);
    assert.equal(calls.length, 1);
  }, { content: '', thinking: '{"action":{"type":"click","target":{"ref":"c1"}}}' });
});

test('a verified model click finishes on deterministic next step without a duplicate model action', async () => {
  await withMockedProvider({ CAPTAIN_OLLAMA_MODEL: 'synthetic-test-model', CAPTAIN_OLLAMA_VISION: 'false' }, async calls => {
    const history=[{action:{type:'click',target:{ref:'c1'}},planner:'ollama',
      result:{ok:true}}];
    const plan=await planStep('Use the picture to choose the green control',
      context(),history);
    assert.equal(plan.action.type,'finish');
    assert.equal(plan.planner,'fast-command');
    assert.equal(calls.length,0,'A completed click must not prompt a second unneeded model action.');
    const failed=await planStep('Use the picture to choose the green control',
      context(),[{...history[0],result:{ok:false}}]);
    assert.equal(failed.planner,'ollama');
    assert.equal(calls.length,1,'A failed click cannot be silently accepted as completion.');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../tools/phase-08-heldout-browser-ui.mjs', import.meta.url), 'utf8');

test('partial private-browser audit cannot overwrite previous full scored evidence', () => {
  assert.match(source, /report\.summary\.complete && !failureClass/);
  assert.match(source, /phase-08-heldout-browser-ui-incomplete\.json/);
  assert.match(source, /phase-08-heldout-browser-ui\.json/);
  assert.match(source, /if\(!report\.summary\.complete\|\|failureClass\)process\.exitCode=1/);
});

test('private-browser audit exports only fixed failure enum/stage, not diagnostic exception text', () => {
  assert.match(source, /failureClass='PRIVATE_BROWSER_ACCEPTANCE_FAILED'/);
  assert.match(source, /failureStage='PRIVATE_MODEL_EVALUATION'/);
  assert.doesNotMatch(source, /error\.stack|error\.message|console\.error\(error\)/);
  assert.match(source, /rawScreenshotReturnedToNode:false/);
  assert.match(source, /boxesReturnedToNode:false/);
});

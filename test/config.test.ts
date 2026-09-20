import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelForModel, isCatalogModelId, TECHWORD_DEFAULT_MODEL } from '../src/TechwordConfig';

test('labelForModel returns catalog labels for known ids', () => {
  assert.equal(labelForModel('claude-opus-5'), 'Claude Opus 5');
  assert.equal(labelForModel('claude-opus-4-8'), 'Claude Opus 4.8');
  assert.equal(labelForModel('gpt-5.6-terra'), 'GPT 5.6 Terra');
});

test('labelForModel falls back to the raw id for unknown models', () => {
  assert.equal(labelForModel('some-future-model'), 'some-future-model');
});

test('isCatalogModelId recognises catalog ids only', () => {
  assert.equal(isCatalogModelId('claude-opus-5'), true);
  assert.equal(isCatalogModelId('not-a-model'), false);
});

test('the default model is part of the catalog', () => {
  assert.equal(isCatalogModelId(TECHWORD_DEFAULT_MODEL), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, isSensitivePath, contentHash } from '../src/security/Redaction';

test('redact masks api keys and bearer tokens', () => {
  assert.ok(redact('key sk-EXAMPLEfakeKEY0000000000000000000000').includes('[REDACTED]'));
  assert.ok(redact('Authorization: Bearer abcdef0123456789xyz').includes('[REDACTED]'));
});

test('redact leaves ordinary text untouched', () => {
  assert.equal(redact('const total = a + b;'), 'const total = a + b;');
});

test('isSensitivePath flags secret-like filenames', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('config/credential.json'), true);
  assert.equal(isSensitivePath('src/token-bucket.ts'), true);
  assert.equal(isSensitivePath('src/api.key.txt'), true);
  assert.equal(isSensitivePath('src/utils.ts'), false);
});

test('contentHash is stable and content-sensitive', () => {
  assert.equal(contentHash('hello'), contentHash('hello'));
  assert.notEqual(contentHash('hello'), contentHash('hello!'));
});

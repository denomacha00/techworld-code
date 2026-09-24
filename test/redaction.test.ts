import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, isSensitivePath, contentHash } from '../src/security/Redaction';

test('redact masks api keys and bearer tokens', () => {
  assert.ok(redact('key sk-EXAMPLEfakeKEY0000000000000000000000').includes('[REDACTED]'));
  assert.ok(redact('Authorization: Bearer abcdef0123456789xyz').includes('[REDACTED]'));
});

test('redact leaves ordinary text untouched', () => {
  assert.equal(redact('const total = a + b;'), 'const total = a + b;');
  assert.equal(redact('function makeKey() { return id; }'), 'function makeKey() { return id; }');
});

test('redact masks well-known credential shapes', () => {
  // Sample tokens are assembled at runtime so the literals never sit in source (secret scanners flag them).
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const ghToken = 'gh' + 'p_' + '0123456789abcdefghijABCDEFghijklmnopq';
  const slack = 'xox' + 'b-' + '1234567890-abcdefghijklmnop';
  assert.ok(redact('aws ' + aws + ' here').includes('[REDACTED]'), 'AWS key');
  assert.ok(redact('token ' + ghToken).includes('[REDACTED]'), 'GitHub PAT');
  assert.ok(redact('goog AIza' + 'B'.repeat(35) + ' end').includes('[REDACTED]'), 'Google key');
  assert.ok(redact('slack ' + slack).includes('[REDACTED]'), 'Slack token');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(pem), '[REDACTED]', 'PEM private key block');
});

test('redact masks the value of a credential assignment but keeps the key name', () => {
  const out = redact('password = "hunter2secret"');
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.includes('password'), 'the field name stays so the shape is still visible');
  assert.ok(!out.includes('hunter2secret'));
});

test('redact masks segmented sk- keys (sk-ant-…, sk-proj-…) that have internal hyphens', () => {
  const antKey = 'sk-' + 'ant-' + 'api03-' + 'A'.repeat(24);
  const projKey = 'sk-' + 'proj-' + 'B'.repeat(20);
  assert.ok(!redact('key ' + antKey).includes('ant-api03'), 'Anthropic-style segmented key is masked');
  assert.ok(redact('key ' + antKey).includes('[REDACTED]'));
  assert.ok(redact('key ' + projKey).includes('[REDACTED]'));
});

test('redact masks more credential field names (token/access_token/apiToken/secretKey)', () => {
  for (const line of [
    'access_token = "abcdef123456"',
    'accessToken: "abcdef123456"',
    'apiToken = "abcdef123456"',
    'secretKey: "abcdef123456"',
    'token = "abcdef123456"'
  ]) {
    const out = redact(line);
    assert.ok(out.includes('[REDACTED]'), `${line} → value masked`);
    assert.ok(!out.includes('abcdef123456'), `${line} → secret value gone`);
  }
});

test('redact does not over-mask an unrelated identifier ending in "token"', () => {
  // `nextToken` is a common non-secret field (pagination cursor); the bare-token rule must not fire on the
  // "token" tail of another identifier. (A real accessToken field IS caught by its own alternative above.)
  const out = redact('const nextToken = "page-2-cursor";');
  assert.ok(out.includes('page-2-cursor'), 'a pagination cursor is left readable');
});

test('isSensitivePath flags secret-like filenames', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('config/credential.json'), true);
  assert.equal(isSensitivePath('src/token-bucket.ts'), true);
  assert.equal(isSensitivePath('src/api.key.txt'), true);
  assert.equal(isSensitivePath('.ssh/id_rsa'), true);
  assert.equal(isSensitivePath('certs/server.pem'), true);
  assert.equal(isSensitivePath('keystore.jks'), true);
  assert.equal(isSensitivePath('.npmrc'), true);
  assert.equal(isSensitivePath('src/utils.ts'), false);
  assert.equal(isSensitivePath('src/monkey.ts'), false);
  assert.equal(isSensitivePath('src/keyboard.ts'), false);
});

test('contentHash is stable and content-sensitive', () => {
  assert.equal(contentHash('hello'), contentHash('hello'));
  assert.notEqual(contentHash('hello'), contentHash('hello!'));
});

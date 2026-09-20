import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewerVersion, parseManifest, resolveVsixUrl } from '../src/update/updateLogic';

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('1.7.4', '1.7.3'), 1);
  assert.equal(compareVersions('1.7.3', '1.7.4'), -1);
  assert.equal(compareVersions('1.7.4', '1.7.4'), 0);
  // 1.10 must beat 1.9 (lexical string compare would get this wrong)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('compareVersions tolerates a leading v and uneven segment counts', () => {
  assert.equal(compareVersions('v1.8', '1.8.0'), 0);
  assert.equal(compareVersions('1.8.1', 'v1.8'), 1);
});

test('isNewerVersion is strict — an equal version is not an update', () => {
  assert.equal(isNewerVersion('1.7.4', '1.7.5'), true);
  assert.equal(isNewerVersion('1.7.4', '1.7.4'), false);
  assert.equal(isNewerVersion('1.7.4', '1.7.3'), false);
});

test('parseManifest accepts a well-formed manifest and strips a leading v', () => {
  const m = parseManifest({ version: 'v1.8.0', vsixUrl: '/releases/x.vsix', notes: 'hi' });
  assert.deepEqual(m, { version: '1.8.0', vsixUrl: '/releases/x.vsix', notes: 'hi' });
});

test('parseManifest accepts url + releaseNotes aliases', () => {
  const m = parseManifest({ version: '1.8.0', url: 'https://h/x.vsix', releaseNotes: 'notes' });
  assert.equal(m?.vsixUrl, 'https://h/x.vsix');
  assert.equal(m?.notes, 'notes');
});

test('parseManifest rejects junk so a bad server response is never treated as a release', () => {
  assert.equal(parseManifest(undefined), undefined);
  assert.equal(parseManifest('nope'), undefined);
  assert.equal(parseManifest({ version: '1.8.0' }), undefined, 'no download url');
  assert.equal(parseManifest({ vsixUrl: '/x.vsix' }), undefined, 'no version');
  assert.equal(parseManifest({ version: 'latest', vsixUrl: '/x.vsix' }), undefined, 'non-numeric version');
});

test('resolveVsixUrl resolves a relative path against the manifest and forces https', () => {
  assert.equal(
    resolveVsixUrl('https://up.example.app/latest.json', '/releases/techword-code-1.8.0.vsix'),
    'https://up.example.app/releases/techword-code-1.8.0.vsix'
  );
  // http is upgraded to https
  assert.equal(resolveVsixUrl('https://up.example.app/latest.json', 'http://cdn.example/x.vsix'), 'https://cdn.example/x.vsix');
  // an absolute https url passes through
  assert.equal(resolveVsixUrl('https://up.example.app/latest.json', 'https://cdn.example/x.vsix'), 'https://cdn.example/x.vsix');
});

test('resolveVsixUrl refuses a non-web scheme (no file:/data: downloads)', () => {
  assert.equal(resolveVsixUrl('https://up.example.app/latest.json', 'file:///etc/passwd'), undefined);
});

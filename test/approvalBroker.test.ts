import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../src/security/ApprovalBroker';

test('a request can be consumed once with the same proposal', () => {
  const broker = new ApprovalBroker();
  const proposal = { command: 'npm test', purpose: 'run tests' };
  const request = broker.request(proposal);
  assert.equal(broker.consume(request.id, proposal), true);
  // second consume fails: already removed
  assert.equal(broker.consume(request.id, proposal), false);
});

test('a tampered proposal is rejected', () => {
  const broker = new ApprovalBroker();
  const request = broker.request({ command: 'npm test', purpose: 'run tests' });
  assert.equal(broker.consume(request.id, { command: 'rm -rf /', purpose: 'run tests' }), false);
});

test('reject removes a pending request', () => {
  const broker = new ApprovalBroker();
  const proposal = { command: 'ls', purpose: 'list' };
  const request = broker.request(proposal);
  broker.reject(request.id);
  assert.equal(broker.consume(request.id, proposal), false);
});

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

test('an approval never times out — a slow but genuine "Approve" is still honored', () => {
  // Regression: the broker used to reject any approval older than 10 minutes. When a user stepped away
  // or reviewed a big diff slowly, their real Approve click was silently turned into a rejection, which
  // read as the agent randomly refusing to edit files or run commands. There is no wall-clock deadline:
  // the wait for the click has no timeout, so consume must accept it regardless of how long it took.
  const broker = new ApprovalBroker();
  const proposal = { command: 'npm run build', purpose: 'build' };
  const request = broker.request(proposal);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60 * 60 * 1000; // pretend an hour passed while the user decided
    assert.equal(broker.consume(request.id, proposal), true, 'a slow approval must still apply');
  } finally {
    Date.now = realNow;
  }
});

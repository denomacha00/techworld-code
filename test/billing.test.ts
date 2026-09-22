import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBillingUsd } from '../src/providers/billing';

// The billing meter is what makes the cost counter EXACT — it reports the dollars the provider actually
// deducted for the key (input/output price difference already baked in). These test the one risky part:
// turning the gateway's raw numbers into dollars, from the breaking-input stance.

test('cents meter (OpenAI convention): total_usage 500 → $5.00', () => {
  const out = parseBillingUsd({ totalUsage: 500, hardLimitUsd: 5 }, true);
  assert.equal(out.spentUsd, 5);
  assert.equal(out.limitUsd, 5);
});

test('dollars meter: total_usage is already dollars when meterInCents is false', () => {
  const out = parseBillingUsd({ totalUsage: 5, hardLimitUsd: 5 }, false);
  assert.equal(out.spentUsd, 5, 'no /100 applied');
});

test('the $1-cap test key: 100 cents spent reads as exactly $1.00 against a $1 cap', () => {
  const out = parseBillingUsd({ totalUsage: 100, hardLimitUsd: 1 }, true);
  assert.equal(out.spentUsd, 1);
  assert.equal(out.limitUsd, 1);
});

test('a fresh key (0 spend) is $0, not blank or NaN', () => {
  const out = parseBillingUsd({ totalUsage: 0, hardLimitUsd: 1 }, true);
  assert.equal(out.spentUsd, 0);
  assert.equal(out.limitUsd, 1);
});

test('a missing cap is dropped (undefined), not shown as $0 — an unlimited key has no bar', () => {
  assert.equal(parseBillingUsd({ totalUsage: 250, hardLimitUsd: undefined }, true).limitUsd, undefined);
  assert.equal(parseBillingUsd({ totalUsage: 250, hardLimitUsd: 0 }, true).limitUsd, undefined, 'a 0 cap is treated as no cap');
});

test('a negative meter reading can never render as negative spend', () => {
  assert.equal(parseBillingUsd({ totalUsage: -10, hardLimitUsd: 5 }, true).spentUsd, 0);
});

test('fractional cents survive the conversion (sub-cent spend is still visible)', () => {
  assert.equal(parseBillingUsd({ totalUsage: 0.5, hardLimitUsd: 1 }, true).spentUsd, 0.005);
});

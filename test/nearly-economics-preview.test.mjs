import test from 'node:test';
import assert from 'node:assert/strict';
import { previewNearlyTaxAllocation } from '../src/nearly-economics-preview.mjs';

const fraction = (numerator, denominator = '1') => ({ numerator, denominator });

test('reproduces the PRD 10,000 taxable-unit example exactly', () => {
  assert.deepEqual(previewNearlyTaxAllocation('10000'), {
    taxableAmountUnits: '10000',
    taxBps: 300,
    taxCollected: fraction('300'),
    creatorControlled: fraction('210'),
    mission: fraction('168'),
    holders: fraction('21'),
    directBurn: fraction('21'),
    nearlyProtocol: fraction('60'),
    referrals: fraction('30'),
  });
});

test('uses exact fractions rather than inventing contract rounding for fractional splits', () => {
  const preview = previewNearlyTaxAllocation('1');
  assert.deepEqual(preview.taxCollected, fraction('3', '100'));
  assert.deepEqual(preview.mission, fraction('21', '1250'));
  assert.deepEqual(preview.holders, fraction('21', '10000'));
  assert.deepEqual(preview.directBurn, fraction('21', '10000'));
  assert.deepEqual(preview.nearlyProtocol, fraction('3', '500'));
  assert.deepEqual(preview.referrals, fraction('3', '1000'));
});

test('supports very large base-unit amounts without precision loss', () => {
  const amount = '9007199254740993123456789';
  const preview = previewNearlyTaxAllocation(amount);
  assert.equal(preview.taxableAmountUnits, amount);
  assert.deepEqual(preview.taxCollected, fraction('27021597764222979370370367', '100'));
});

test('rejects non-integer, negative, or non-string trade amounts', () => {
  for (const amount of ['1.2', '-1', '', 10000, null]) {
    assert.throws(() => previewNearlyTaxAllocation(amount), /non-negative integer string/);
  }
});

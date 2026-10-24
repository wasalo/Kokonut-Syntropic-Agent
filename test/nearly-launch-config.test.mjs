import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNearlyLaunchConfig } from '../src/nearly-launch-config.mjs';

const validConfig = {
  launchpad: 'nearly.trade',
  network: 'near:mainnet',
  pair_asset: 'wrap.near',
  creator_share_bps: 6000,
  tax: {
    buy_bps: 300,
    sell_bps: 300,
    creator_bps: 8000,
    holders_bps: 1000,
    burn_bps: 1000,
  },
  token_name: 'Kokonut Syntropic Agent — NEAR (provisional)',
  ticker: 'TBD',
  creator_account: '<verify-governed-recipient-and-factory-caller>',
  launch_id: null,
  token_account: null,
};

test('accepts the contract-aligned validation model without treating it as launch authorization', () => {
  assert.deepEqual(validateNearlyLaunchConfig(validConfig), []);
});

test('rejects the documentation-only 7000 bps pool-fee share when it is outside contract bounds', () => {
  const config = structuredClone(validConfig);
  config.creator_share_bps = 7000;
  assert.ok(validateNearlyLaunchConfig(config).some((issue) => issue.includes('creator_share_bps')));
});

test('rejects a changed buy or sell tax rate', () => {
  const config = structuredClone(validConfig);
  config.tax.buy_bps = 400;
  assert.ok(validateNearlyLaunchConfig(config).some((issue) => issue.includes('buy_bps')));
});

test('rejects creator allocation weights that do not conserve 100 percent', () => {
  const config = structuredClone(validConfig);
  config.tax.holders_bps = 900;
  assert.ok(validateNearlyLaunchConfig(config).some((issue) => issue.includes('sum to 10000')));
});

test('rejects a non-mainnet network or non-NEAR pair asset', () => {
  const config = structuredClone(validConfig);
  config.network = 'near:testnet';
  config.pair_asset = 'usdt.near';
  const issues = validateNearlyLaunchConfig(config);
  assert.ok(issues.some((issue) => issue.includes('near:mainnet')));
  assert.ok(issues.some((issue) => issue.includes('wrap.near')));
});

test('rejects launch-ready identifiers where the PRD requires unresolved placeholders', () => {
  const config = structuredClone(validConfig);
  config.creator_account = 'agent.near';
  config.launch_id = '42';
  config.token_account = 'token.near';
  const issues = validateNearlyLaunchConfig(config);
  assert.ok(issues.some((issue) => issue.includes('creator_account')));
  assert.ok(issues.some((issue) => issue.includes('launch_id')));
  assert.ok(issues.some((issue) => issue.includes('token_account')));
});

test('rejects missing and malformed inputs without throwing', () => {
  assert.ok(validateNearlyLaunchConfig(null).length > 0);
  assert.ok(validateNearlyLaunchConfig({ tax: {} }).length > 0);
});

test('rejects unknown root fields instead of accepting launch arguments', () => {
  const config = structuredClone(validConfig);
  config.launch_transaction = true;
  assert.ok(validateNearlyLaunchConfig(config).some((issue) => issue.includes('unknown field')));
});

test('rejects unknown tax fields', () => {
  const config = structuredClone(validConfig);
  config.tax.fee_recipient = 'other.near';
  assert.ok(validateNearlyLaunchConfig(config).some((issue) => issue.includes('unknown tax field')));
});

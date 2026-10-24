import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNearlyFactorySnapshot, readNearlyFactorySnapshot } from '../src/nearly-readiness.mjs';

const anchor = { height: 221331059, hash: '86sFn72nvAjpFivqt141ZUyDMU2DtCNSsuCYEXhuJ8Qc' };
const snapshot = {
  factoryAccount: 'nearlytrade.near',
  block: anchor,
  codeHash: '9mwfrbtBbDr3y2t9rHY944qAQTU2PsB5smqsAHZJo4G5',
  config: {
    total_supply: '1000000000000000000000000000',
    pool_fee: 10000,
    creator_fee_share_bps: 6000,
  },
  creatorShareBounds: [6000, 6000],
  taxBounds: [400, true, 3000],
  quotes: [['wrap.near', { enabled: true, decimals: 24 }]],
  launchCount: 3432,
  sourceBlockHashes: [anchor.hash, anchor.hash, anchor.hash, anchor.hash, anchor.hash, anchor.hash],
};

test('readiness evaluation blocks snapshots from an unexpected factory account', () => {
  const invalid = structuredClone(snapshot);
  invalid.factoryAccount = 'attacker.near';
  const report = evaluateNearlyFactorySnapshot(invalid);
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.find((check) => check.id === 'factory_account')?.status, 'blocker');
});

test('readiness accepts the on-chain creator pool-fee share of 6000 bps but leaves human gates open', () => {
  const report = evaluateNearlyFactorySnapshot(snapshot);
  assert.equal(report.status, 'manual_review_required');
  const shareCheck = report.checks.find((check) => check.id === 'creator_pool_fee_share');
  assert.equal(shareCheck.status, 'pass');
  assert.deepEqual(shareCheck.expected, { configured_bps: 6000, allowed_bounds_include_bps: 6000 });
  assert.deepEqual(shareCheck.observed, { configured: 6000, allowed_bounds: [6000, 6000] });
  assert.equal(report.factory.codeHash, snapshot.codeHash);
  assert.equal(report.launchAuthorized, false);
});

test('readiness blocks a 7000 bps pool-fee share outside current contract bounds', () => {
  const changed = structuredClone(snapshot);
  changed.config.creator_fee_share_bps = 7000;
  const report = evaluateNearlyFactorySnapshot(changed);
  assert.equal(report.status, 'blocked');
  const shareCheck = report.checks.find((check) => check.id === 'creator_pool_fee_share');
  assert.equal(shareCheck.status, 'blocker');
  assert.deepEqual(shareCheck.observed, { configured: 7000, allowed_bounds: [6000, 6000] });
});

test('readiness blocks the 70/20/10 target while the factory tax platform share is 4000 bps', () => {
  const deployed = structuredClone(snapshot);
  deployed.taxBounds = [400, true, 4000];
  const report = evaluateNearlyFactorySnapshot(deployed);
  assert.equal(report.status, 'blocked');
  const check = report.checks.find(({ id }) => id === 'tax_economics_compatibility');
  assert.equal(check.status, 'blocker');
  assert.deepEqual(check.expected, {
    max_tax_bps_at_least: 300,
    tax_code_installed: true,
    platform_tax_bps: 3000,
  });
  assert.deepEqual(check.observed, {
    max_tax_bps: 400,
    tax_code_installed: true,
    platform_tax_bps: 4000,
  });
  assert.equal(report.launchAuthorized, false);
});

test('readiness fails closed on a malformed tax-bound tuple', () => {
  const malformed = structuredClone(snapshot);
  malformed.taxBounds = [400, true, 3000, 999];
  const report = evaluateNearlyFactorySnapshot(malformed);
  const check = report.checks.find(({ id }) => id === 'tax_economics_compatibility');
  assert.equal(report.status, 'blocked');
  assert.equal(check.status, 'blocker');
});

test('readiness fails closed when tax-bound tuple elements have wrong types', () => {
  for (const taxBounds of [[400, 'true', 3000], ['400', true, 3000], [400, true, '3000'], [400.5, true, 3000]]) {
    const malformed = structuredClone(snapshot);
    malformed.taxBounds = taxBounds;
    const report = evaluateNearlyFactorySnapshot(malformed);
    const check = report.checks.find(({ id }) => id === 'tax_economics_compatibility');
    assert.equal(report.status, 'blocked');
    assert.equal(check.status, 'blocker');
    assert.deepEqual(check.observed, taxBounds);
  }
});

test('readiness keeps the 70/20/10 target as manual review after contract compatibility passes', () => {
  const report = evaluateNearlyFactorySnapshot(snapshot);
  const check = report.checks.find(({ id }) => id === 'tax_economics_compatibility');
  assert.equal(check.status, 'pass');
  assert.equal(report.status, 'manual_review_required');
  assert.equal(report.launchAuthorized, false);
});

test('readiness report keeps human/legal and launch-specific gates open', () => {
  const readySnapshot = structuredClone(snapshot);
  readySnapshot.config.creator_fee_share_bps = 6000;
  readySnapshot.creatorShareBounds = [6000, 6000];
  const report = evaluateNearlyFactorySnapshot(readySnapshot);
  assert.equal(report.status, 'manual_review_required');
  for (const id of ['legal_issuer', 'beneficiary_routing', 'legal_security_signoff', 'tax_payload', 'token_state']) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, 'manual_review');
  }
});

test('factory snapshot reader pins every view to one final block and captures the code hash', async () => {
  const requests = [];
  const responses = {
    block: { header: anchor },
    view_code: { hash: snapshot.codeHash, block_height: anchor.height, block_hash: anchor.hash },
    get_config: snapshot.config,
    get_creator_share_bounds: [6000, 6000],
    get_tax_bounds: [400, true, 3000],
    get_quotes: [['wrap.near', { enabled: true, decimals: 24 }]],
    get_num_launches: 3432,
  };
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    let result;
    if (request.method === 'block') {
      result = responses.block;
    } else if (request.method === 'query' && request.params.request_type === 'view_code') {
      result = responses.view_code;
    } else {
      const method = request.params.method_name;
      result = {
        result: [...Buffer.from(JSON.stringify(responses[method]))],
        block_height: anchor.height,
        block_hash: anchor.hash,
      };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
  };

  const result = await readNearlyFactorySnapshot({ fetchImpl });
  assert.equal(result.block.hash, anchor.hash);
  assert.equal(result.codeHash, snapshot.codeHash);
  assert.equal(result.config.creator_fee_share_bps, 6000);
  assert.deepEqual(result.taxBounds, [400, true, 3000]);
  const queries = requests.filter((request) => request.method === 'query');
  assert.equal(queries.length, 6);
  assert.ok(queries.every((request) => request.params.block_id === anchor.hash));
});

test('readiness blocks when a view response is served at a different block hash', async () => {
  const responses = {
    view_code: { hash: snapshot.codeHash, block_height: anchor.height, block_hash: anchor.hash },
    get_config: snapshot.config,
    get_creator_share_bounds: [6000, 6000],
    get_tax_bounds: [400, true, 3000],
    get_quotes: [['wrap.near', { enabled: true, decimals: 24 }]],
    get_num_launches: 3432,
  };
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    let result;
    if (request.method === 'block') {
      result = { header: anchor };
    } else if (request.method === 'query' && request.params.request_type === 'view_code') {
      result = responses.view_code;
    } else {
      const method = request.params.method_name;
      result = {
        result: [...Buffer.from(JSON.stringify(responses[method]))],
        block_height: anchor.height,
        block_hash: method === 'get_tax_bounds' ? 'different-final-block-hash' : anchor.hash,
      };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
  };

  const observed = await readNearlyFactorySnapshot({ fetchImpl });
  const report = evaluateNearlyFactorySnapshot(observed);
  const consistency = report.checks.find(({ id }) => id === 'snapshot_consistency');
  assert.equal(consistency.status, 'blocker');
  assert.equal(observed.sourceBlockHashes[3], 'different-final-block-hash');
  assert.equal(report.status, 'blocked');
  assert.equal(report.launchAuthorized, false);
});

test('factory snapshot reader rejects RPC errors instead of returning partial readiness data', async () => {
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'unavailable' } }) };
  };
  await assert.rejects(readNearlyFactorySnapshot({ fetchImpl }), /NEAR RPC block failed/);
});

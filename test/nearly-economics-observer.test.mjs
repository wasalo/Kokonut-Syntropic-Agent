import test from 'node:test';
import assert from 'node:assert/strict';
import { readNearlyEconomicsSnapshot } from '../src/nearly-economics-observer.mjs';

const block = { height: 123, hash: 'final-block-hash' };
const launch = {
  id: 2,
  token: 'observer-test.nearlytrade.near',
  creator: 'creator.near',
  name: 'Observer test',
  symbol: 'OBS',
  total_supply: '1000000000000000000000000000',
  pool_id: 'observer-test.nearlytrade.near|wrap.near|10000',
  token_is_x: true,
  lpt_id: 'observer-test.nearlytrade.near|wrap.near|10000#7',
  step: 'Done',
  quote: 'wrap.near',
  fees_near_total: '0',
  fees_token_total: '100',
  creator_token_fees: '12',
  creator_quote_fees: '34',
};
const methods = {
  get_config: { creator_fee_share_bps: 6000, total_supply: '1000000000000000000000000000' },
  get_launch: launch,
  get_fee_opts: { mode: 'creator', creator_share_bps: 7000, bucket: '0', burned: '0', paid_holders: '0' },
  get_tax: { buy_bps: 300, sell_bps: 300, creator_bps: 8000, holders_bps: 1000, burn_bps: 1000 },
  get_locker_for: 'lock.nearlytrade.near',
  get_quotes: [['wrap.near', { decimals: 24, enabled: true }]],
  ft_metadata: { spec: 'ft-1.0.0', name: 'Observer test', symbol: 'OBS', decimals: 18 },
  ft_total_supply: '999999999999999999999999999',
  get_liquidity: {
    lpt_id: launch.lpt_id,
    owner_id: 'lock.nearlytrade.near',
    pool_id: launch.pool_id,
    unclaimed_fee_x: '1234567890123456789',
    unclaimed_fee_y: '2500000000000000000000000',
  },
};
const codeHashes = {
  'nearlytrade.near': 'factory-code-hash',
  'observer-test.nearlytrade.near': 'token-code-hash',
  'lock.nearlytrade.near': 'locker-code-hash',
  'dclv2.ref-labs.near': 'exchange-code-hash',
};

function createFetch({ overrideMethods = {}, wrongBlockMethod = null } = {}) {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    let result;
    if (request.method === 'block') {
      result = { header: block };
    } else if (request.params.request_type === 'view_code') {
      result = { hash: codeHashes[request.params.account_id], block_hash: block.hash, block_height: block.height };
    } else {
      const method = request.params.method_name;
      const value = Object.hasOwn(overrideMethods, method) ? overrideMethods[method] : methods[method];
      const responseBlock = method === wrongBlockMethod ? 'different-block-hash' : block.hash;
      result = {
        result: [...Buffer.from(JSON.stringify(value))],
        block_hash: responseBlock,
        block_height: block.height,
      };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
  };
  return { fetchImpl, requests };
}

test('reads an exact-block launch snapshot and keeps factory defaults separate from per-launch fee options', async () => {
  const { fetchImpl } = createFetch();
  const snapshot = await readNearlyEconomicsSnapshot('2', { fetchImpl });

  assert.deepEqual(snapshot.block, block);
  assert.equal(snapshot.factory.account, 'nearlytrade.near');
  assert.equal(snapshot.factory.config.creator_fee_share_bps, 6000);
  assert.equal(snapshot.launch.id, 2);
  assert.equal(snapshot.launch.feeOptions.creator_share_bps, 7000);
  assert.equal(snapshot.launch.tax.buy_bps, 300);
  assert.equal(snapshot.token.totalSupply, '999999999999999999999999999');
  assert.equal(snapshot.poolPosition.ownerId, 'lock.nearlytrade.near');
  assert.deepEqual(snapshot.poolPosition.unclaimedFees, [
    { asset: 'observer-test.nearlytrade.near', amountBaseUnits: '1234567890123456789', decimals: 18 },
    { asset: 'wrap.near', amountBaseUnits: '2500000000000000000000000', decimals: 24 },
  ]);
  assert.equal(snapshot.integrity.lockerOwnsPosition, true);
  assert.equal(snapshot.history.indexed, false);
});

test('pins every state and code read to the same finalized block hash', async () => {
  const { fetchImpl, requests } = createFetch();
  await readNearlyEconomicsSnapshot('2', { fetchImpl });

  const rpcQueries = requests.filter((request) => request.method === 'query');
  assert.ok(rpcQueries.length >= 10);
  for (const request of rpcQueries) assert.equal(request.params.block_id, block.hash);
});

test('rejects malformed launch IDs before making an RPC request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not call RPC'); };
  await assert.rejects(readNearlyEconomicsSnapshot('02', { fetchImpl }), /non-negative integer string/);
  await assert.rejects(readNearlyEconomicsSnapshot('-1', { fetchImpl }), /non-negative integer string/);
  assert.equal(calls, 0);
});

test('rejects a launch record whose ID does not match the requested ID', async () => {
  const { fetchImpl } = createFetch({ overrideMethods: { get_launch: { ...launch, id: 7 } } });
  await assert.rejects(readNearlyEconomicsSnapshot('2', { fetchImpl }), /does not match requested launch ID/);
});

test('rejects responses served at a different block than the pinned final block', async () => {
  const { fetchImpl } = createFetch({ wrongBlockMethod: 'get_fee_opts' });
  await assert.rejects(readNearlyEconomicsSnapshot('2', { fetchImpl }), /not pinned to the requested final block/);
});

test('represents a no-tax launch explicitly and skips pool-position reads without an LP token ID', async () => {
  const { fetchImpl, requests } = createFetch({
    overrideMethods: {
      get_launch: { ...launch, lpt_id: null },
      get_tax: null,
      get_locker_for: null,
    },
  });
  const snapshot = await readNearlyEconomicsSnapshot('2', { fetchImpl });
  assert.equal(snapshot.launch.tax, null);
  assert.equal(snapshot.poolPosition, null);
  assert.equal(snapshot.history.indexed, false);
  assert.equal(requests.some((request) => request.params?.method_name === 'get_liquidity'), false);
});

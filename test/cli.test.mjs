import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const manifest = {
  schema_version: '1.0',
  agent_id: '9ddfc9c8-c871-4c12-b0a6-70e86bc8cc89',
  display_name: 'Example Syntropic Agent',
  runtime: 'Hermes',
  operator_entity_ref: '<example-only>',
  ki_agent_identity_ref: '<deferred>',
  near_hub_contract: '<pending-approval>',
  policy_hash: `sha256:${'a'.repeat(64)}`,
  capability_manifest_hash: `sha256:${'b'.repeat(64)}`,
  chain_instances: [{ namespace: 'near', chain_id: 'mainnet', instance_ref: 'near-hub', role: 'orchestration' }],
  status: 'active',
};
const nearlyConfig = {
  launchpad: 'nearly.trade',
  network: 'near:mainnet',
  pair_asset: 'wrap.near',
  creator_share_bps: 6000,
  tax: { buy_bps: 300, sell_bps: 300, creator_bps: 8000, holders_bps: 1000, burn_bps: 1000 },
  token_name: 'Example token — provisional',
  ticker: 'TBD',
  creator_account: '<verify-governed-recipient-and-factory-caller>',
  launch_id: null,
  token_account: null,
};

function runCli(args, value) {
  const dir = mkdtempSync(join(tmpdir(), 'syntropic-cli-'));
  try {
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, typeof value === 'string' ? value : JSON.stringify(value));
    return spawnSync(process.execPath, [cli, ...args, inputPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('manifest command validates input and prints its canonical SHA-256 digest', () => {
  const result = runCli(['manifest'], manifest);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Valid AgentManifest\nsha256:[a-f0-9]{64}\n$/);
});

test('manifest command exits nonzero and explains invalid input', () => {
  const invalid = { ...manifest, agent_id: 'invalid' };
  const result = runCli(['manifest'], invalid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent_id must be a UUID/);
});

test('nearly command validates the model and states that it is not live verification', () => {
  const result = runCli(['nearly'], nearlyConfig);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matches the local contract-aligned model only/);
  assert.match(result.stdout, /does not verify live contract state or authorize launch/);
});

test('nearly command rejects a configuration mismatch', () => {
  const invalid = structuredClone(nearlyConfig);
  invalid.tax.sell_bps = 400;
  const result = runCli(['nearly'], invalid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tax.sell_bps must be 300/);
});

test('preview command prints exact tax allocation fractions for a taxable amount', () => {
  const result = spawnSync(process.execPath, [cli, 'preview', '10000'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"mission":\s*\{\s*"numerator":\s*"168",\s*"denominator":\s*"1"\s*\}/);
  assert.match(result.stderr, /[Ii]llustrative math only/);
});

test('near-readiness command prints a blocked report when observed factory state differs from the launch model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'syntropic-live-check-'));
  try {
    const preloadPath = join(dir, 'mock-rpc.mjs');
    const mockCode = `
      const block = { height: 123, hash: 'final-block-hash' };
      const values = {
        get_config: { total_supply: '1000000000000000000000000000', creator_fee_share_bps: 7000 },
        get_creator_share_bounds: [6000, 6000],
        get_quotes: [['wrap.near', { enabled: true }]],
        get_num_launches: 42
      };
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        let result;
        if (request.method === 'block') result = { header: block };
        else if (request.params.request_type === 'view_code') result = { hash: 'factory-code-hash', block_hash: block.hash, block_height: block.height };
        else result = { result: [...Buffer.from(JSON.stringify(values[request.params.method_name]))], block_hash: block.hash, block_height: block.height };
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
      };
    `;
    writeFileSync(preloadPath, mockCode);
    const result = spawnSync(process.execPath, ['--import', preloadPath, cli, 'near-readiness'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /"status": "blocked"/);
    assert.match(result.stdout, /"configured": 7000/);
    assert.match(result.stdout, /"launchAuthorized": false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('near-economics command prints a read-only finalized launch snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'syntropic-economics-check-'));
  try {
    const preloadPath = join(dir, 'mock-rpc.mjs');
    const mockCode = `
      const block = { height: 321, hash: 'economics-final-block' };
      const launch = {
        id: 2, token: 'observer-test.nearlytrade.near', creator: 'creator.near',
        name: 'Observer test', symbol: 'OBS', pool_id: 'obs|wrap.near|10000',
        token_is_x: true, lpt_id: 'obs|wrap.near|10000#7', step: 'Done', quote: 'wrap.near',
        fees_near_total: '0', fees_token_total: '100', creator_token_fees: '12', creator_quote_fees: '34'
      };
      const values = {
        get_config: { creator_fee_share_bps: 6000, total_supply: '1000000000000000000000000000' },
        get_launch: launch,
        get_fee_opts: { mode: 'creator', creator_share_bps: 7000, bucket: '0', burned: '0', paid_holders: '0' },
        get_tax: null,
        get_locker_for: 'lock.nearlytrade.near',
        get_quotes: [['wrap.near', { decimals: 24, enabled: true }]],
        ft_metadata: { spec: 'ft-1.0.0', name: 'Observer test', symbol: 'OBS', decimals: 18 },
        ft_total_supply: '999999999999999999999999999',
        get_liquidity: {
          lpt_id: launch.lpt_id, owner_id: 'lock.nearlytrade.near', pool_id: launch.pool_id,
          unclaimed_fee_x: '123', unclaimed_fee_y: '456'
        }
      };
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        let result;
        if (request.method === 'block') result = { header: block };
        else if (request.params.request_type === 'view_code') {
          result = { hash: request.params.account_id + '-code-hash', block_hash: block.hash, block_height: block.height };
        } else {
          const value = values[request.params.method_name];
          result = { result: [...Buffer.from(JSON.stringify(value))], block_hash: block.hash, block_height: block.height };
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
      };
    `;
    writeFileSync(preloadPath, mockCode);
    const result = spawnSync(process.execPath, ['--import', preloadPath, cli, 'near-economics', '2'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.block.hash, 'economics-final-block');
    assert.equal(snapshot.factory.config.creator_fee_share_bps, 6000);
    assert.equal(snapshot.launch.feeOptions.creator_share_bps, 7000);
    assert.equal(snapshot.history.indexed, false);
    assert.equal(snapshot.launchAuthorized, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('near-economics rejects a malformed launch ID and reports usage without querying the network', () => {
  const invalid = spawnSync(process.execPath, [cli, 'near-economics', '02'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /non-negative integer string/);

  const missing = spawnSync(process.execPath, [cli, 'near-economics'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage:/);
});

test('near-events command indexes a local NEAR Lake message without sending chain transactions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'syntropic-near-events-'));
  try {
    const inputPath = join(dir, 'message.json');
    const event = {
      standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
      data: [{ old_owner_id: 'alice.near', new_owner_id: 'bob.near', amount: '25' }],
    };
    const message = {
      block: { header: { height: 500, hash: 'near-lake-block-hash' } },
      shards: [{
        shard_id: 3,
        receipt_execution_outcomes: [{
          receipt: { receipt_id: 'receipt-abc' },
          execution_outcome: {
            id: 'receipt-abc', block_hash: 'near-lake-block-hash',
            outcome: { executor_id: 'token.near', logs: [`EVENT_JSON:${JSON.stringify(event)}`] },
          },
        }],
      }],
    };
    writeFileSync(inputPath, JSON.stringify(message));
    const result = spawnSync(process.execPath, [cli, 'near-events', inputPath, 'token.near'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const indexed = JSON.parse(result.stdout);
    assert.equal(indexed.events.length, 1);
    assert.equal(indexed.events[0].executorAccountId, 'token.near');
    assert.equal(indexed.events[0].event, 'ft_transfer');
    assert.equal(indexed.events[0].data[0].amount, '25');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('near-events reports malformed local input and usage errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'syntropic-near-events-invalid-'));
  try {
    const inputPath = join(dir, 'invalid.json');
    writeFileSync(inputPath, '{not json');
    const malformed = spawnSync(process.execPath, [cli, 'near-events', inputPath], { encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const missing = spawnSync(process.execPath, [cli, 'near-events'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage:/);
});

test('near-account-events is listed in usage and rejects invalid argument counts before network access', () => {
  const missing = spawnSync(process.execPath, [cli, 'near-account-events'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /near-account-events <accountId>/);

  const extra = spawnSync(process.execPath, [cli, 'near-account-events', 'token.near', 'cursor', 'extra'], { encoding: 'utf8' });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /near-account-events <accountId>/);
});

test('CLI reports malformed JSON and usage errors with a distinct usage exit code', () => {
  const malformed = runCli(['manifest'], '{not json');
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /invalid JSON/);

  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
});

function runNearAudit(status = 'SuccessValue') {
  const dir = mkdtempSync(join(tmpdir(), 'syntropic-near-audit-'));
  try {
    const preloadPath = join(dir, 'mock-fastnear.mjs');
    const mockCode = `
      const expectedHash = 'test-transaction-hash';
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://tx.main.fastnear.com/v0/transactions') throw new Error('unexpected endpoint');
        if (options.method !== 'POST' || JSON.stringify(JSON.parse(options.body)) !== JSON.stringify({ tx_hashes: [expectedHash] })) throw new Error('unexpected request');
        const transaction = {
          hash: expectedHash, signer_id: 'sender.near', receiver_id: 'receiver.near',
          actions: [{ Transfer: { deposit: '123' } }]
        };
        const result = {
          transaction,
          execution_outcome: {
            id: expectedHash, block_height: 456, block_hash: 'block-hash',
            outcome: { status: { ${status}: '' }, logs: [], receipt_ids: [] }
          },
          receipts: [], data_receipts: []
        };
        return { ok: true, status: 200, json: async () => ({ transactions: [result] }) };
      };
    `;
    writeFileSync(preloadPath, mockCode);
    return spawnSync(process.execPath, ['--import', preloadPath, cli, 'near-tx-audit', 'test-transaction-hash'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('near-tx-audit prints valid JSON and observational native transfer evidence', () => {
  const result = runNearAudit();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.transaction.hash, 'test-transaction-hash');
  assert.equal(report.rootExecution.actions[0].amount, '123');
  assert.match(report.semantics, /does not verify payout/);
});

test('near-tx-audit prints partial JSON and exits nonzero', () => {
  const result = runNearAudit('UnrecognizedStatus');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'partial');
});

test('near-tx-audit rejects missing and extra arguments with usage before network access', () => {
  const missing = spawnSync(process.execPath, [cli, 'near-tx-audit'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /near-tx-audit <transactionHash>/);

  const extra = spawnSync(process.execPath, [cli, 'near-tx-audit', 'hash', 'extra'], { encoding: 'utf8' });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /near-tx-audit <transactionHash>/);

  const malformed = spawnSync(process.execPath, [cli, 'near-tx-audit', ' hash '], { encoding: 'utf8' });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /near-tx-audit <transactionHash>/);
});

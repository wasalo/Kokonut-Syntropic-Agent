import test from 'node:test';
import assert from 'node:assert/strict';
import { readFastNearEventLogPage } from '../src/fastnear-event-history.mjs';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const eventLog = `EVENT_JSON:${JSON.stringify({
  standard: 'nearpad',
  version: '2.0.0',
  event: 'tax_collected',
  data: [{ id: 2, amount: '55' }],
})}`;

function transaction(hash = 'tx-1', { emitter = 'token.near', logs = [eventLog] } = {}) {
  return {
    transaction: { hash },
    execution_outcome: {
      id: hash,
      block_hash: 'tx-block-hash',
      block_height: 700,
      outcome: { executor_id: 'wallet.near', logs: [], status: { SuccessReceiptId: 'receipt-1' } },
    },
    receipts: [{
      receipt: { receipt_id: 'receipt-1', receiver_id: emitter },
      execution_outcome: {
        id: 'receipt-1',
        block_hash: 'receipt-block-hash',
        block_height: 701,
        outcome: { executor_id: emitter, logs, status: { SuccessValue: '' } },
      },
    }],
    data_receipts: [],
  };
}

function accountPage(hashes = ['tx-1'], resumeToken = 'cursor-next') {
  return {
    account_txs: hashes.map((transaction_hash) => ({
      account_id: 'token.near', transaction_hash, is_event_log: true, tx_block_height: 700,
    })),
    resume_token: resumeToken,
    txs_count: hashes.length,
  };
}

test('hydrates account event-log history and preserves receipt-level event provenance', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/v0/account')) return response(accountPage(['tx-1'], 'cursor-next'));
    if (url.endsWith('/v0/transactions')) return response({ transactions: [transaction()] });
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await readFastNearEventLogPage({
    accountId: 'token.near',
    resumeToken: 'cursor-in',
    apiKey: 'test-only-key',
    fetchImpl,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://tx.main.fastnear.com/v0/account');
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-only-key');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    account_id: 'token.near',
    is_event_log: true,
    desc: false,
    limit: 20,
    resume_token: 'cursor-in',
  });
  assert.deepEqual(JSON.parse(requests[1].init.body), { tx_hashes: ['tx-1'] });
  assert.equal(result.accountId, 'token.near');
  assert.equal(result.pageStatus, 'page_processed');
  assert.equal(result.transactionsRequested, 1);
  assert.equal(result.transactionsHydrated, 1);
  assert.equal(result.missingTransactionHashes.length, 0);
  assert.equal(result.nextResumeToken, 'cursor-next');
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    eventId: 'near:mainnet:receipt-block-hash:receipt-1:0',
    transactionHash: 'tx-1',
    blockHeight: 701,
    blockHash: 'receipt-block-hash',
    shardId: null,
    executionOutcomeId: 'receipt-1',
    receiptId: 'receipt-1',
    executorAccountId: 'token.near',
    logIndex: 0,
    standard: 'nearpad',
    version: '2.0.0',
    event: 'tax_collected',
    data: [{ id: 2, amount: '55' }],
    rawLog: eventLog,
    executionStatus: { SuccessValue: '' },
  });
  assert.equal(JSON.stringify(result).includes('test-only-key'), false);
});

test('does not infer the emitter from an account appearing in event data', async () => {
  const otherEvent = `EVENT_JSON:${JSON.stringify({
    standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: 'token.near', new_owner_id: 'other.near', amount: '5' }],
  })}`;
  const fetchImpl = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['tx-1'], null))
    : response({ transactions: [transaction('tx-1', { emitter: 'other.near', logs: [otherEvent] })] });
  const result = await readFastNearEventLogPage({ accountId: 'token.near', fetchImpl });
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.quarantined, []);
});

test('marks a page partial when an indexed transaction cannot be hydrated', async () => {
  const fetchImpl = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['missing-tx'], null))
    : response({ transactions: [] });
  const result = await readFastNearEventLogPage({ accountId: 'token.near', fetchImpl });
  assert.equal(result.pageStatus, 'partial');
  assert.deepEqual(result.missingTransactionHashes, ['missing-tx']);
});

test('hydrates event logs in batches of at most twenty transaction hashes', async () => {
  const hashes = Array.from({ length: 21 }, (_, index) => `tx-${index + 1}`);
  const transactionRequests = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v0/account')) return response(accountPage(hashes, null));
    const requested = JSON.parse(init.body).tx_hashes;
    transactionRequests.push(requested);
    return response({ transactions: requested.map((hash) => transaction(hash, { logs: [] })) });
  };
  const result = await readFastNearEventLogPage({ accountId: 'token.near', limit: 21, fetchImpl });
  assert.deepEqual(transactionRequests.map((batch) => batch.length), [20, 1]);
  assert.equal(result.transactionsRequested, 21);
  assert.equal(result.transactionsHydrated, 21);
  assert.equal(result.pageStatus, 'page_processed');
});

test('quarantines malformed matching logs and retains their event provenance', async () => {
  const fetchImpl = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['tx-1'], null))
    : response({ transactions: [transaction('tx-1', { logs: ['EVENT_JSON:{bad-json'] })] });
  const result = await readFastNearEventLogPage({ accountId: 'token.near', fetchImpl });
  assert.equal(result.events.length, 0);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].transactionHash, 'tx-1');
  assert.equal(result.quarantined[0].receiptId, 'receipt-1');
  assert.equal(result.quarantined[0].error, 'event log is not valid JSON');
  assert.equal(result.pageStatus, 'partial');
});

test('quarantines event logs when executor identity is missing instead of assuming the queried account emitted them', async () => {
  const tx = transaction();
  delete tx.receipts[0].execution_outcome.outcome.executor_id;
  const fetchImpl = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['tx-1'], null))
    : response({ transactions: [tx] });
  const result = await readFastNearEventLogPage({ accountId: 'token.near', fetchImpl });
  assert.equal(result.events.length, 0);
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0].error, /cannot verify emitter/);
  assert.equal(result.pageStatus, 'partial');
});

test('rejects malformed receipt collections rather than silently omitting outcomes', async () => {
  const tx = transaction();
  tx.receipts = 'not-an-array';
  const fetchImpl = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['tx-1'], null))
    : response({ transactions: [tx] });
  await assert.rejects(
    readFastNearEventLogPage({ accountId: 'token.near', fetchImpl }),
    /FastNear transaction receipts must be an array/,
  );
});

test('rejects missing transaction outcomes and missing logs arrays rather than silently omitting chain data', async () => {
  const missingRoot = transaction();
  missingRoot.execution_outcome = null;
  const rootFetch = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['tx-1'], null))
    : response({ transactions: [missingRoot] });
  await assert.rejects(
    readFastNearEventLogPage({ accountId: 'token.near', fetchImpl: rootFetch }),
    /FastNear transaction response is missing execution_outcome/,
  );

  const missingLogs = transaction();
  delete missingLogs.receipts[0].execution_outcome.outcome.logs;
  const logsFetch = async (url) => url.endsWith('/v0/account')
    ? response(accountPage(['tx-1'], null))
    : response({ transactions: [missingLogs] });
  await assert.rejects(
    readFastNearEventLogPage({ accountId: 'token.near', fetchImpl: logsFetch }),
    /execution outcome receipt-1 logs must be an array/,
  );
});

test('rejects HTTP errors and malformed request values without returning partial results', async () => {
  await assert.rejects(
    readFastNearEventLogPage({ accountId: 'token.near', fetchImpl: async () => response({}, 503) }),
    /FastNear account history request failed: HTTP 503/,
  );
  await assert.rejects(
    readFastNearEventLogPage({ accountId: '', fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /accountId must be a non-empty string/,
  );
  await assert.rejects(
    readFastNearEventLogPage({ accountId: 'token.near', limit: 201, fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /limit must be an integer from 1 to 200/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditNearTransaction, readFastNearTransactionAudit } from '../src/near-transaction-audit.mjs';

const transaction = {
  transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
  execution_outcome: { id: 'tx', outcome: { receipt_ids: ['r1'], logs: [], status: 'SuccessValue' } },
  receipts: [{
    receipt: { receipt_id: 'r1', receipt: { Action: { actions: [] } } },
    execution_outcome: { outcome: { status: 'SuccessValue', receipt_ids: [], logs: [] } },
  }],
  data_receipts: [],
};

test('marks receipt entries with absent outcome IDs as partial and mismatched', () => {
  const report = auditNearTransaction(transaction);
  assert.equal(report.status, 'partial');
  assert.equal(report.graph.complete, false);
  assert.deepEqual(report.graph.mismatchedIds, [{ receiptId: 'r1', outcomeId: null }]);
  assert.match(report.diagnostics.join(' '), /outcome ID/i);
});

const completeReceipt = (id) => ({
  receipt: { receipt_id: id, receipt: { Action: { actions: [] } } },
  execution_outcome: { id, outcome: { status: 'SuccessValue', receipt_ids: [], logs: [] } },
});

test('reports duplicate receipt references as incomplete graph evidence', () => {
  const duplicateReference = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: ['r1', 'r1'], logs: [], status: 'SuccessValue' } },
    receipts: [completeReceipt('r1')],
    data_receipts: [],
  };
  const report = auditNearTransaction(duplicateReference);
  assert.equal(report.status, 'partial');
  assert.equal(report.graph.complete, false);
  assert.deepEqual(report.graph.duplicateIds, ['r1']);
});

test('marks malformed raw-log collections partial instead of silently replacing them', () => {
  const malformedLogs = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: [], logs: 'not-an-array', status: 'SuccessValue' } },
    receipts: [],
    data_receipts: [],
  };
  const report = auditNearTransaction(malformedLogs);
  assert.equal(report.status, 'partial');
  assert.equal(report.rootExecution.logs, 'not-an-array');
  assert.match(report.diagnostics.join(' '), /logs must be an array/i);
});

test('reports absent receipt references and leaves graph incomplete', () => {
  const missing = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: ['not-hydrated'], logs: [], status: 'SuccessValue' } },
    receipts: [],
    data_receipts: [],
  };
  const report = auditNearTransaction(missing);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.graph.missingIds, ['not-hydrated']);
});

test('reports duplicate, mismatched, and orphan receipt identities', () => {
  const inconsistent = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: ['r1', 'r1'], logs: [], status: 'SuccessValue' } },
    receipts: [
      { receipt: { receipt_id: 'r1', receipt: { Action: { actions: [] } } }, execution_outcome: { id: 'other', outcome: { status: 'SuccessValue', receipt_ids: [], logs: [] } } },
      completeReceipt('orphan'),
      completeReceipt('r1'),
    ],
    data_receipts: [],
  };
  const report = auditNearTransaction(inconsistent);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.graph.duplicateIds, ['r1']);
  assert.deepEqual(report.graph.mismatchedIds, [{ receiptId: 'r1', outcomeId: 'other' }]);
  assert.deepEqual(report.graph.orphanIds, ['orphan']);
});

test('does not report native transfers from failed receipts and does not expose call arguments', () => {
  const failed = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: ['r1'], logs: [], status: 'SuccessValue' } },
    receipts: [{
      receipt: { receipt_id: 'r1', receiver_id: 'token.near', receipt: { Action: { actions: [
        { Transfer: { deposit: '3' } },
        { FunctionCall: { method_name: 'ft_transfer', args: 'not-json:private', deposit: '1' } },
      ] } } },
      execution_outcome: { id: 'r1', outcome: { status: { Failure: { error_message: 'failed' } }, receipt_ids: [], logs: ['raw failure'] } },
    }],
    data_receipts: [],
  };
  const report = auditNearTransaction(failed);
  assert.deepEqual(report.actionReceipts[0].actions, [
    { type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' },
  ]);
  assert.deepEqual(report.actionReceipts[0].logs, ['raw failure']);
  assert.equal(JSON.stringify(report).includes('not-json:private'), false);
});

test('marks absent or malformed required receipt collections partial', () => {
  const malformed = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: [], logs: [], status: 'SuccessValue' } },
    receipts: 'bad',
    data_receipts: [],
  };
  const report = auditNearTransaction(malformed);
  assert.equal(report.status, 'partial');
  assert.equal(report.graph.complete, false);
  assert.match(report.diagnostics.join(' '), /receipts must be an array/);
});

test('preserves raw success statuses, logs, provenance, and FastNear-shaped data receipt nodes', () => {
  const observed = {
    transaction: { hash: 'tx-main', signer_id: 'alice.near', receiver_id: 'app.near', actions: [{ Transfer: { deposit: '7' } }] },
    status: { SuccessValue: '' },
    execution_outcome: {
      id: 'tx-main', block_height: 80, block_hash: 'block-root',
      outcome: { status: { SuccessReceiptId: 'native' }, receipt_ids: ['native'], logs: ['root raw log'] },
    },
    receipts: [
      {
        receipt: {
          receipt_id: 'native', receiver_id: 'bob.near',
          receipt: { Action: { actions: [{ Transfer: { deposit: '10' } }] } },
        },
        execution_outcome: {
          id: 'native', block_height: 81, block_hash: 'block-1',
          outcome: { status: { SuccessValue: '' }, receipt_ids: ['ft'], logs: ['native raw log'] },
        },
      },
      {
        receipt: {
          receipt_id: 'ft', receiver_id: 'token.near',
          receipt: { Action: { actions: [{
            FunctionCall: {
              method_name: 'ft_transfer',
              args: `{"receiver_id":"hidden.near","memo":"hidden"}`,
              deposit: '1',
            },
          }] } },
        },
        execution_outcome: {
          id: 'ft', block_height: 81, block_hash: 'block-1',
          outcome: { status: 'SuccessValue', receipt_ids: [], logs: ['ft raw log'] },
        },
      },
    ],
    data_receipts: [{
      receipt_id: 'data', predecessor_id: 'app.near', receiver_id: 'alice.near',
      block_height: 81, block_hash: 'data-block',
      receipt: { Data: { data_id: 'data-id', data: 'private-payload', is_promise_resume: false } },
    }],
  };
  const report = auditNearTransaction(observed);
  assert.equal(report.status, 'complete');
  assert.equal(report.transaction.hash, 'tx-main');
  assert.equal(report.transaction.signerId, 'alice.near');
  assert.equal(report.rootExecution.blockHeight, 80);
  assert.deepEqual(report.rootExecution.executionStatus, { SuccessReceiptId: 'native' });
  assert.deepEqual(report.rootExecution.logs, ['root raw log']);
  assert.deepEqual(report.rootExecution.actions, [{ type: 'native_transfer', observation: 'successful_transaction_action', amount: '7', destination: 'app.near', actionIndex: 0 }]);
  assert.deepEqual(report.actionReceipts[0].actions, [{ type: 'native_transfer', observation: 'successful_receipt_action', amount: '10', destination: 'bob.near', actionIndex: 0 }]);
  assert.deepEqual(report.actionReceipts[1].actions, [{ type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' }]);
  assert.deepEqual(report.actionReceipts[0].executionStatus, { SuccessValue: '' });
  assert.deepEqual(report.dataReceipts, [{ receiptId: 'data', predecessorId: 'app.near', receiverId: 'alice.near', blockHeight: 81, blockHash: 'data-block', dataId: 'data-id', isPromiseResume: false }]);
  assert.deepEqual(report.graph, { complete: true, missingIds: [], duplicateIds: [], mismatchedIds: [], orphanIds: [] });
  assert.doesNotMatch(JSON.stringify(report), /hidden\.near|hidden|private-payload/);
  assert.match(report.semantics, /observational/i);
  assert.doesNotMatch(report.semantics, /payout.*completed|tax.*completed|rewards.*completed/i);
});

test('requires root transaction actions and diagnoses missing or malformed collections', () => {
  for (const actions of [undefined, 'invalid']) {
    const malformed = structuredClone(transaction);
    if (actions === undefined) delete malformed.transaction.actions;
    else malformed.transaction.actions = actions;
    const report = auditNearTransaction(malformed);
    assert.equal(report.status, 'partial');
    assert.equal(report.graph.complete, false);
    assert.match(report.diagnostics.join(' '), /transaction actions must be an array/i);
  }
});

test('reports root transaction ft_transfer function calls as call-only without arguments', () => {
  const withCall = structuredClone(transaction);
  withCall.transaction.actions = [{ FunctionCall: {
    method_name: 'ft_transfer', args: 'secret args', deposit: '1',
  } }];
  const report = auditNearTransaction(withCall);
  assert.deepEqual(report.rootExecution.actions, [
    { type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /secret args/);
});

test('fails closed on invalid fields in successful root and receipt native transfers', () => {
  const invalidTransfers = [
    { where: 'root', action: { Transfer: { deposit: '', receiver_id: 'bob.near' } } },
    { where: 'root', action: { Transfer: { deposit: '1.2', receiver_id: 'bob.near' } } },
    { where: 'root', action: { Transfer: { deposit: '1' } } },
    { where: 'root', action: { Transfer: { deposit: '1', receiver_id: '' } } },
    { where: 'receipt', action: { Transfer: { deposit: '', receiver_id: 'bob.near' } } },
    { where: 'receipt', action: { Transfer: { deposit: '1.2', receiver_id: 'bob.near' } } },
    { where: 'receipt', action: { Transfer: { deposit: '1' } } },
    { where: 'receipt', action: { Transfer: { deposit: '1', receiver_id: '' } } },
  ];
  for (const { where, action } of invalidTransfers) {
    const input = structuredClone(transaction);
    if (where === 'root') {
      input.transaction.actions = [action];
      input.transaction.receiver_id = action.Transfer.receiver_id;
    }
    else {
      input.receipts[0].receipt.receiver_id = action.Transfer.receiver_id;
      input.receipts[0].receipt.receipt.Action.actions = [action];
      input.execution_outcome.outcome.receipt_ids = ['r1'];
      input.receipts[0].execution_outcome.id = 'r1';
    }
    const report = auditNearTransaction(input);
    assert.equal(report.status, 'partial', `${where} transfer ${JSON.stringify(action)}`);
    const observations = where === 'root' ? report.rootExecution.actions : report.actionReceipts[0].actions;
    assert.equal(observations[0].observation, 'incomplete_successful_transfer');
    assert.match(report.diagnostics.join(' '), /native transfer.*(deposit|destination)/i);
  }
});

test('keeps malformed and duplicate data receipts visible without corrupting the action graph', () => {
  const report = auditNearTransaction({
    transaction: { hash: 'tx', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: ['r1'], logs: [], status: 'SuccessValue' } },
    receipts: [completeReceipt('r1')],
    data_receipts: [
      { receipt_id: 'data', predecessor_id: 'app.near', receiver_id: 'alice.near', receipt: { Data: { data_id: 'd1' } } },
      { receipt_id: 'data', predecessor_id: 'app.near', receiver_id: 'alice.near', receipt: { Data: { data_id: 'd1' } } },
      { receipt_id: 'broken', receipt: { Action: {} } },
    ],
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.graph.complete, true);
  assert.deepEqual(report.dataReceipts.map(({ receiptId }) => receiptId), ['data']);
  assert.match(report.diagnostics.join(' '), /duplicate receipt ID data/i);
  assert.match(report.diagnostics.join(' '), /malformed FastNear Data receipt/i);
});

test('marks malformed action lists partial while retaining receipt provenance', () => {
  const malformedActions = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near', actions: [] },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: ['r1'], logs: [], status: 'SuccessValue' } },
    receipts: [{
      receipt: { receipt_id: 'r1', receipt: { Action: { actions: 'invalid' } } },
      execution_outcome: { id: 'r1', outcome: { status: 'SuccessValue', receipt_ids: [], logs: [] } },
    }],
    data_receipts: [],
  };
  const report = auditNearTransaction(malformedActions);
  assert.equal(report.status, 'partial');
  assert.equal(report.actionReceipts[0].receiptId, 'r1');
  assert.match(report.diagnostics.join(' '), /actions must be an array/i);
});

test('does not treat unexpected root statuses as successful native transfers', () => {
  for (const status of ['SuccessGarbage', { SuccessValue: '', Failure: {} }, 'Unknown', undefined]) {
    const malformed = structuredClone(transaction);
    malformed.transaction.actions = [{ Transfer: { deposit: '5' } }];
    malformed.execution_outcome.outcome.status = status;
    const report = auditNearTransaction(malformed);

    assert.equal(report.status, 'partial', `status ${JSON.stringify(status)}`);
    assert.deepEqual(report.rootExecution.actions, [], `status ${JSON.stringify(status)}`);
    assert.deepEqual(report.rootExecution.executionStatus, status ?? null);
    assert.match(report.diagnostics.join(' '), /root execution.*status/i);
  }
});

test('does not treat unexpected receipt statuses as successful native transfers', () => {
  for (const status of ['SuccessGarbage', { SuccessValue: '', Failure: {} }, 'Unknown', undefined]) {
    const malformed = structuredClone(transaction);
    malformed.receipts[0].receipt.receipt.Action.actions = [{ Transfer: { deposit: '5' } }];
    malformed.receipts[0].receipt.receiver_id = 'bob.near';
    malformed.receipts[0].execution_outcome.id = 'r1';
    malformed.receipts[0].execution_outcome.outcome.status = status;
    const report = auditNearTransaction(malformed);

    assert.equal(report.status, 'partial', `status ${JSON.stringify(status)}`);
    assert.deepEqual(report.actionReceipts[0].actions, [], `status ${JSON.stringify(status)}`);
    assert.deepEqual(report.actionReceipts[0].executionStatus, status ?? null);
    assert.match(report.diagnostics.join(' '), /receipt r1.*status/i);
  }
});

test('recognizes exact Failure as terminal without making the audit partial', () => {
  const failed = structuredClone(transaction);
  failed.transaction.actions = [{ Transfer: { deposit: '5' } }];
  failed.execution_outcome.outcome.receipt_ids = [];
  failed.receipts = [];
  failed.execution_outcome.outcome.status = { Failure: { error_message: 'failed' } };
  const report = auditNearTransaction(failed);

  assert.equal(report.status, 'complete');
  assert.deepEqual(report.rootExecution.actions, []);
  assert.deepEqual(report.diagnostics, []);
});

test('rejects malformed root and receipt status variant payloads without validating transfers', () => {
  const malformedStatuses = [
    { SuccessValue: 42 },
    { SuccessReceiptId: '' },
    { SuccessReceiptId: 42 },
    { Failure: 'failed' },
    { Failure: null },
    { SuccessValue: '', Failure: {} },
  ];

  for (const status of malformedStatuses) {
    for (const where of ['root', 'receipt']) {
      const malformed = structuredClone(transaction);
      malformed.transaction.actions = where === 'root' ? [{ Transfer: { deposit: '5' } }] : [];
      if (where === 'receipt') {
        malformed.execution_outcome.outcome.receipt_ids = ['r1'];
        malformed.receipts[0].receipt.receipt_id = 'r1';
        malformed.receipts[0].receipt.receiver_id = 'bob.near';
        malformed.receipts[0].receipt.receipt.Action.actions = [{ Transfer: { deposit: '5' } }];
        malformed.receipts[0].execution_outcome.id = 'r1';
        malformed.receipts[0].execution_outcome.outcome.status = status;
      } else {
        malformed.execution_outcome.outcome.status = status;
      }

      const report = auditNearTransaction(malformed);
      assert.equal(report.status, 'partial', `${where} status ${JSON.stringify(status)}`);
      const provenance = where === 'root' ? report.rootExecution : report.actionReceipts[0];
      assert.deepEqual(provenance.actions, [], `${where} status ${JSON.stringify(status)}`);
      assert.deepEqual(provenance.executionStatus, status);
      assert.match(report.diagnostics.join(' '), /status/i);
    }
  }
});

test('marks a root execution outcome ID that differs from the transaction hash partial', () => {
  const mismatched = structuredClone(transaction);
  mismatched.execution_outcome.id = 'different-root-id';
  const report = auditNearTransaction(mismatched);
  assert.equal(report.status, 'partial');
  assert.match(report.diagnostics.join(' '), /root execution outcome ID.*transaction hash/i);
});

test('looks up and audits exactly the requested FastNear transaction', async () => {
  let request;
  const report = await readFastNearTransactionAudit({
    transactionHash: 'tx', apiKey: 'secret-test-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ transactions: [structuredClone(transaction)] }) };
    },
  });
  assert.equal(request.url, 'https://tx.main.fastnear.com/v0/transactions');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { tx_hashes: ['tx'] });
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.headers.authorization, 'Bearer secret-test-key');
  assert.equal(report.transaction.hash, 'tx');
  assert.doesNotMatch(JSON.stringify(report), /secret-test-key/);
});

test('does not send authorization when FastNear API key is absent', async () => {
  let request;
  await readFastNearTransactionAudit({
    transactionHash: 'tx', apiKey: '',
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ transactions: [structuredClone(transaction)] }) };
    },
  });
  assert.equal(Object.hasOwn(request.headers, 'authorization'), false);
});

test('rejects FastNear HTTP failures without exposing response bodies or credentials', async () => {
  await assert.rejects(readFastNearTransactionAudit({
    transactionHash: 'tx', apiKey: 'secret-test-key',
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'secret response body' }),
  }), (error) => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /secret-test-key|secret response body/);
    return true;
  });
});

test('rejects malformed FastNear JSON', async () => {
  await assert.rejects(readFastNearTransactionAudit({
    transactionHash: 'tx', fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
  }), /JSON/i);
});

test('rejects a missing or malformed FastNear transactions array', async () => {
  for (const body of [{}, { transactions: 'bad' }]) {
    await assert.rejects(readFastNearTransactionAudit({
      transactionHash: 'tx', fetchImpl: async () => ({ ok: true, json: async () => body }),
    }), /transactions.*array/i);
  }
});

test('rejects missing and different-hash FastNear transactions', async () => {
  for (const transactions of [[], [{ ...structuredClone(transaction), transaction: { ...transaction.transaction, hash: 'other' } }]]) {
    await assert.rejects(readFastNearTransactionAudit({
      transactionHash: 'tx', fetchImpl: async () => ({ ok: true, json: async () => ({ transactions }) }),
    }), /matching transaction/i);
  }
});

test('rejects duplicate matching FastNear transactions', async () => {
  await assert.rejects(readFastNearTransactionAudit({
    transactionHash: 'tx', fetchImpl: async () => ({ ok: true, json: async () => ({ transactions: [structuredClone(transaction), structuredClone(transaction)] }) }),
  }), /exactly one/i);
});

test('validates transaction hashes without normalizing them', async () => {
  for (const transactionHash of ['', '   ', 12, null]) {
    await assert.rejects(readFastNearTransactionAudit({
      transactionHash, fetchImpl: async () => { throw new Error('fetch should not run'); },
    }), /non-empty string/i);
  }
});

test('rejects a non-function FastNear fetch implementation', async () => {
  await assert.rejects(readFastNearTransactionAudit({ transactionHash: 'tx', fetchImpl: null }), /fetch.*function/i);
});

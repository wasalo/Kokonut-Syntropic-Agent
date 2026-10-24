import test from 'node:test';
import assert from 'node:assert/strict';
import { auditNearTransaction } from '../src/near-transaction-audit.mjs';

const transaction = {
  transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
    execution_outcome: { id: 'tx', outcome: { receipt_ids: [], logs: [], status: 'SuccessValue' } },
    receipts: 'bad',
    data_receipts: [],
  };
  const report = auditNearTransaction(malformed);
  assert.equal(report.status, 'partial');
  assert.equal(report.graph.complete, false);
  assert.match(report.diagnostics.join(' '), /receipts must be an array/);
});

test('preserves raw success statuses, logs, provenance, and separate data receipt nodes', () => {
  const observed = {
    transaction: { hash: 'tx-main', signer_id: 'alice.near', receiver_id: 'app.near' },
    status: { SuccessValue: '' },
    execution_outcome: {
      id: 'tx-main', block_height: 80, block_hash: 'block-root',
      outcome: { status: { SuccessReceiptId: 'native' }, receipt_ids: ['native', 'ft', 'data'], logs: ['root raw log'] },
    },
    receipts: [
      {
        receipt: {
          receipt_id: 'native', receiver_id: 'bob.near',
          receipt: { Action: { actions: [{ Transfer: { deposit: '10' } }] } },
        },
        execution_outcome: {
          id: 'native', block_height: 81, block_hash: 'block-1',
          outcome: { status: { SuccessValue: '' }, receipt_ids: [], logs: ['native raw log'] },
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
    data_receipts: [{ receipt: { receipt_id: 'data', predecessor_id: 'app.near', receiver_id: 'alice.near' } }],
  };
  const report = auditNearTransaction(observed);
  assert.equal(report.status, 'complete');
  assert.equal(report.transaction.hash, 'tx-main');
  assert.equal(report.transaction.signerId, 'alice.near');
  assert.equal(report.rootExecution.blockHeight, 80);
  assert.deepEqual(report.rootExecution.executionStatus, { SuccessReceiptId: 'native' });
  assert.deepEqual(report.rootExecution.logs, ['root raw log']);
  assert.deepEqual(report.actionReceipts[0].actions, [{ type: 'native_transfer', observation: 'successful_receipt_action' }]);
  assert.deepEqual(report.actionReceipts[1].actions, [{ type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' }]);
  assert.deepEqual(report.actionReceipts[0].executionStatus, { SuccessValue: '' });
  assert.deepEqual(report.dataReceipts.map(({ receiptId }) => receiptId), ['data']);
  assert.deepEqual(report.graph, { complete: true, missingIds: [], duplicateIds: [], mismatchedIds: [], orphanIds: [] });
  assert.doesNotMatch(JSON.stringify(report), /hidden\.near|hidden/);
  assert.match(report.semantics, /observational/i);
  assert.doesNotMatch(report.semantics, /payout.*completed|tax.*completed|rewards.*completed/i);
});

test('marks malformed action lists partial while retaining receipt provenance', () => {
  const malformedActions = {
    transaction: { hash: 'tx', signer_id: 'alice.near', receiver_id: 'app.near' },
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

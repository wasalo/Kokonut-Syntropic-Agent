import test from 'node:test';
import assert from 'node:assert/strict';
import { indexNearLakeBlock, indexNearLakeMessages } from '../src/near-event-indexer.mjs';

const blockHash = 'near-lake-block-hash';
const eventLog = `EVENT_JSON:${JSON.stringify({
  standard: 'nep141',
  version: '1.0.0',
  event: 'ft_transfer',
  data: [{ old_owner_id: 'alice.near', new_owner_id: 'bob.near', amount: '25' }],
})}`;
const blockMessage = {
  block: { header: { height: 500, hash: blockHash } },
  shards: [{
    shard_id: 3,
    receipt_execution_outcomes: [{
      receipt: { receipt_id: 'receipt-abc', predecessor_id: 'alice.near', receiver_id: 'token.near' },
      execution_outcome: {
        id: 'receipt-abc',
        block_hash: blockHash,
        outcome: { executor_id: 'token.near', logs: [eventLog, 'plain diagnostic log'] },
      },
    }],
  }],
};

test('normalizes NEP-297 logs with stable block/receipt/log provenance and raw amounts', () => {
  const result = indexNearLakeBlock(blockMessage);
  assert.equal(result.inputFormat, 'near-block-message');
  assert.equal(result.block.height, 500);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    eventId: `near:mainnet:${blockHash}:receipt-abc:0`,
    blockHeight: 500,
    blockHash,
    shardId: 3,
    executionOutcomeId: 'receipt-abc',
    receiptId: 'receipt-abc',
    executorAccountId: 'token.near',
    logIndex: 0,
    standard: 'nep141',
    version: '1.0.0',
    event: 'ft_transfer',
    data: [{ old_owner_id: 'alice.near', new_owner_id: 'bob.near', amount: '25' }],
    rawLog: eventLog,
  });
  assert.equal(result.cursor.nextBlockHeight, 501);
  assert.equal(result.events[0].data[0].amount, '25');
});

test('filters execution logs by explicitly approved contract accounts', () => {
  const result = indexNearLakeBlock(blockMessage, { accountFilter: ['other.near'] });
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.quarantined, []);
});

test('deduplicates repeated execution outcomes by deterministic event ID', () => {
  const duplicate = structuredClone(blockMessage);
  duplicate.shards[0].receipt_execution_outcomes.push(structuredClone(duplicate.shards[0].receipt_execution_outcomes[0]));
  const result = indexNearLakeBlock(duplicate);
  assert.equal(result.events.length, 1);
});

test('quarantines malformed EVENT_JSON logs with provenance instead of dropping them', () => {
  const malformed = structuredClone(blockMessage);
  malformed.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.logs = ['EVENT_JSON:{not-json'];
  const result = indexNearLakeBlock(malformed);
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.quarantined, [{
    eventId: `near:mainnet:${blockHash}:receipt-abc:0`,
    blockHeight: 500,
    blockHash,
    shardId: 3,
    executionOutcomeId: 'receipt-abc',
    receiptId: 'receipt-abc',
    executorAccountId: 'token.near',
    logIndex: 0,
    rawLog: 'EVENT_JSON:{not-json',
    error: 'event log is not valid JSON',
  }]);
});

test('preserves optional NEP-297 data without imposing a project-specific shape', () => {
  const payload = { standard: 'custom-standard', version: '2.0.0', event: 'custom_event', data: { amount: '0.25' } };
  const fixture = structuredClone(blockMessage);
  fixture.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.logs = [
    `EVENT_JSON:${JSON.stringify(payload)}`,
  ];
  const result = indexNearLakeBlock(fixture);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].data, { amount: '0.25' });

  delete payload.data;
  fixture.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.logs = [
    `EVENT_JSON:${JSON.stringify(payload)}`,
  ];
  const withoutData = indexNearLakeBlock(fixture);
  assert.equal(withoutData.events.length, 1);
  assert.equal(Object.hasOwn(withoutData.events[0], 'data'), false);
});

test('quarantines payloads missing required NEP-297 fields', () => {
  const invalid = structuredClone(blockMessage);
  invalid.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.logs = [
    `EVENT_JSON:${JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [] })}`,
  ];
  const result = indexNearLakeBlock(invalid);
  assert.equal(result.events.length, 0);
  assert.match(result.quarantined[0].error, /version/);
});

test('indexes an ordered batch of Near Lake messages and advances a reproducible cursor', () => {
  const nextBlock = structuredClone(blockMessage);
  nextBlock.block.header.height = 501;
  nextBlock.block.header.hash = 'next-near-lake-block-hash';
  const nextExecution = nextBlock.shards[0].receipt_execution_outcomes[0];
  nextExecution.receipt.receipt_id = 'receipt-next';
  nextExecution.execution_outcome.id = 'receipt-next';
  nextExecution.execution_outcome.block_hash = 'next-near-lake-block-hash';

  const result = indexNearLakeMessages([blockMessage, nextBlock]);
  assert.deepEqual(result.blockRange, { from: 500, to: 501 });
  assert.equal(result.blocksIndexed, 2);
  assert.equal(result.events.length, 2);
  assert.equal(result.cursor.nextBlockHeight, 502);
});

test('rejects unordered Near Lake batches rather than emitting an unsafe cursor', () => {
  const nextBlock = structuredClone(blockMessage);
  nextBlock.block.header.height = 501;
  nextBlock.block.header.hash = 'next-near-lake-block-hash';
  nextBlock.shards[0].receipt_execution_outcomes[0].execution_outcome.block_hash = 'next-near-lake-block-hash';
  assert.throws(() => indexNearLakeMessages([nextBlock, blockMessage]), /contiguous, strictly increasing block heights/);
});

test('rejects batches with a height gap rather than advancing past unindexed blocks', () => {
  const laterBlock = structuredClone(blockMessage);
  laterBlock.block.header.height = 502;
  laterBlock.block.header.hash = 'later-near-lake-block-hash';
  laterBlock.shards[0].receipt_execution_outcomes[0].execution_outcome.block_hash = 'later-near-lake-block-hash';
  assert.throws(() => indexNearLakeMessages([blockMessage, laterBlock]), /contiguous, strictly increasing block heights/);
});

test('rejects empty Near Lake batches', () => {
  assert.throws(() => indexNearLakeMessages([]), /at least one block message/);
});

test('rejects execution outcomes from a different block', () => {
  const invalid = structuredClone(blockMessage);
  invalid.shards[0].receipt_execution_outcomes[0].execution_outcome.block_hash = 'other-block';
  assert.throws(() => indexNearLakeBlock(invalid), /outcome block hash does not match/);
});

test('rejects missing block metadata rather than emitting non-reproducible event IDs', () => {
  assert.throws(() => indexNearLakeBlock({ block: {}, shards: [] }), /invalid NEAR Lake block header/);
});

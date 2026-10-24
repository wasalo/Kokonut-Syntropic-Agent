const EVENT_PREFIX = 'EVENT_JSON:';

function identity(blockHash, executionOutcomeId, logIndex) {
  return `near:mainnet:${blockHash}:${executionOutcomeId}:${logIndex}`;
}

function validateEventEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'event JSON must be an object';
  for (const key of ['standard', 'version', 'event']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) return `event JSON is missing ${key}`;
  }
  return null;
}

/** Index NEP-297 logs from one caller-supplied NEAR block message. */
export function indexNearLakeBlock(message, { accountFilter = [] } = {}) {
  const header = message?.block?.header;
  const blockHeight = header?.height;
  const blockHash = header?.hash;
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 0 || typeof blockHash !== 'string' || !blockHash) {
    throw new TypeError('invalid NEAR Lake block header');
  }
  if (!Array.isArray(message.shards)) throw new TypeError('NEAR Lake message shards must be an array');
  if (!Array.isArray(accountFilter) || accountFilter.some((account) => typeof account !== 'string' || !account)) {
    throw new TypeError('accountFilter must contain non-empty account IDs');
  }

  const allowedAccounts = new Set(accountFilter);
  const events = [];
  const quarantined = [];
  const seen = new Set();

  for (const shard of message.shards) {
    const shardId = shard?.shard_id ?? null;
    const executions = shard?.receipt_execution_outcomes ?? [];
    if (!Array.isArray(executions)) throw new TypeError(`shard ${shardId ?? 'unknown'} receipt outcomes must be an array`);

    for (const executionWithReceipt of executions) {
      const execution = executionWithReceipt?.execution_outcome;
      const outcome = execution?.outcome;
      const executionOutcomeId = execution?.id;
      const executorAccountId = outcome?.executor_id;
      if (typeof executionOutcomeId !== 'string' || !executionOutcomeId || typeof executorAccountId !== 'string' || !executorAccountId) {
        throw new TypeError('NEAR Lake receipt execution is missing its outcome ID or executor account');
      }
      if (execution.block_hash && execution.block_hash !== blockHash) {
        throw new Error(`outcome block hash does not match NEAR Lake block for ${executionOutcomeId}`);
      }
      if (allowedAccounts.size > 0 && !allowedAccounts.has(executorAccountId)) continue;

      const logs = outcome.logs ?? [];
      if (!Array.isArray(logs)) throw new TypeError(`execution outcome ${executionOutcomeId} logs must be an array`);
      const receiptId = executionWithReceipt?.receipt?.receipt_id ?? executionOutcomeId;
      for (let logIndex = 0; logIndex < logs.length; logIndex += 1) {
        const rawLog = logs[logIndex];
        if (typeof rawLog !== 'string' || !rawLog.startsWith(EVENT_PREFIX)) continue;

        const eventId = identity(blockHash, executionOutcomeId, logIndex);
        if (seen.has(eventId)) continue;
        seen.add(eventId);

        let parsed;
        try {
          parsed = JSON.parse(rawLog.slice(EVENT_PREFIX.length));
        } catch {
          quarantined.push({
            eventId, blockHeight, blockHash, shardId, executionOutcomeId, receiptId,
            executorAccountId, logIndex, rawLog, error: 'event log is not valid JSON',
          });
          continue;
        }

        const envelopeError = validateEventEnvelope(parsed);
        if (envelopeError) {
          quarantined.push({
            eventId, blockHeight, blockHash, shardId, executionOutcomeId, receiptId,
            executorAccountId, logIndex, rawLog, error: envelopeError,
          });
          continue;
        }

        events.push({
          eventId,
          blockHeight,
          blockHash,
          shardId,
          executionOutcomeId,
          receiptId,
          executorAccountId,
          logIndex,
          standard: parsed.standard,
          version: parsed.version,
          event: parsed.event,
          ...(Object.hasOwn(parsed, 'data') ? { data: parsed.data } : {}),
          rawLog,
        });
      }
    }
  }

  return {
    schemaVersion: '1.0',
    inputFormat: 'near-block-message',
    block: { height: blockHeight, hash: blockHash },
    events,
    quarantined,
    cursor: { nextBlockHeight: blockHeight + 1 },
    semantics: 'Raw event observations only; no tax/reward classification, transaction-tree reconstruction, payout verification, or KI persistence is performed.',
  };
}

export function indexNearLakeMessages(messages, { accountFilter = [] } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('at least one block message is required');
  }
  const blocks = messages.map((message) => indexNearLakeBlock(message, { accountFilter }));
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index].block.height !== blocks[index - 1].block.height + 1) {
      throw new Error('Near Lake batch must contain contiguous, strictly increasing block heights');
    }
  }

  const eventMap = new Map();
  const quarantineMap = new Map();
  for (const block of blocks) {
    for (const event of block.events) eventMap.set(event.eventId, event);
    for (const event of block.quarantined) quarantineMap.set(event.eventId, event);
  }

  return {
    schemaVersion: '1.0',
    inputFormat: 'near-block-message',
    blocksIndexed: blocks.length,
    blockRange: { from: blocks[0].block.height, to: blocks.at(-1).block.height },
    events: [...eventMap.values()],
    quarantined: [...quarantineMap.values()],
    cursor: { nextBlockHeight: blocks.at(-1).cursor.nextBlockHeight },
    semantics: blocks[0].semantics,
  };
}

import { indexNearLakeBlock } from './near-event-indexer.mjs';

const API_BASE_URL = 'https://tx.main.fastnear.com';
const TRANSACTION_BATCH_SIZE = 20;
const EVENT_PREFIX = 'EVENT_JSON:';

function validatePageOptions({ accountId, resumeToken, limit }) {
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new TypeError('accountId must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new TypeError('limit must be an integer from 1 to 200');
  }
  if (resumeToken !== undefined && resumeToken !== null && typeof resumeToken !== 'string') {
    throw new TypeError('resumeToken must be a string when provided');
  }
}

async function postJson(fetchImpl, url, body, headers, operation) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response?.ok) {
    throw new Error(`FastNear ${operation} request failed: HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.json();
}

function transactionOutcomes(transaction) {
  if (!transaction.execution_outcome) throw new TypeError('FastNear transaction response is missing execution_outcome');
  const outcomes = [{ execution: transaction.execution_outcome, receipt: null }];
  const receipts = transaction.receipts ?? [];
  const dataReceipts = transaction.data_receipts ?? [];
  if (!Array.isArray(receipts)) throw new TypeError('FastNear transaction receipts must be an array');
  if (!Array.isArray(dataReceipts)) throw new TypeError('FastNear transaction data_receipts must be an array');
  for (const entry of receipts) {
    if (entry?.execution_outcome) outcomes.push({ execution: entry.execution_outcome, receipt: entry.receipt ?? null });
  }
  for (const entry of dataReceipts) {
    if (entry?.execution_outcome) outcomes.push({ execution: entry.execution_outcome, receipt: entry.receipt ?? null });
  }
  return outcomes;
}

function fallbackEventId(transactionHash, executionOutcomeId, logIndex) {
  return `near:mainnet:tx:${transactionHash}:${executionOutcomeId || 'unknown'}:${logIndex}`;
}

function quarantineWithoutBlockMetadata({ transactionHash, executionOutcomeId, receiptId, executorAccountId, logIndex, rawLog, blockHeight }) {
  return {
    eventId: fallbackEventId(transactionHash, executionOutcomeId, logIndex),
    transactionHash,
    blockHeight: Number.isSafeInteger(blockHeight) ? blockHeight : null,
    blockHash: null,
    shardId: null,
    executionOutcomeId: executionOutcomeId || null,
    receiptId: receiptId || null,
    executorAccountId: executorAccountId || null,
    logIndex,
    rawLog,
    error: 'execution outcome is missing a valid block height, block hash, or outcome ID',
  };
}

function parseTransactionEvents(transaction, accountId) {
  const transactionHash = transaction.transaction?.hash;
  if (typeof transactionHash !== 'string' || !transactionHash) {
    throw new TypeError('FastNear transaction response is missing transaction.hash');
  }
  const events = [];
  const quarantined = [];

  for (const { execution, receipt } of transactionOutcomes(transaction)) {
    const outcome = execution?.outcome;
    if (!outcome || typeof outcome !== 'object') {
      throw new TypeError(`execution outcome ${execution?.id ?? 'unknown'} is missing outcome data`);
    }
    const executorAccountId = outcome.executor_id;
    const logs = outcome.logs;
    if (!Array.isArray(logs)) throw new TypeError(`execution outcome ${execution?.id ?? 'unknown'} logs must be an array`);

    for (let logIndex = 0; logIndex < logs.length; logIndex += 1) {
      const rawLog = logs[logIndex];
      if (typeof rawLog !== 'string' || !rawLog.startsWith(EVENT_PREFIX)) continue;

      const executionOutcomeId = execution?.id;
      const receiptId = receipt?.receipt_id ?? null;
      const blockHeight = execution?.block_height;
      const blockHash = execution?.block_hash;
      if (typeof executorAccountId !== 'string' || !executorAccountId) {
        quarantined.push({
          eventId: fallbackEventId(transactionHash, executionOutcomeId, logIndex),
          transactionHash,
          blockHeight: Number.isSafeInteger(blockHeight) ? blockHeight : null,
          blockHash: typeof blockHash === 'string' && blockHash ? blockHash : null,
          shardId: null,
          executionOutcomeId: executionOutcomeId || null,
          receiptId,
          executorAccountId: null,
          logIndex,
          rawLog,
          executionStatus: outcome.status ?? null,
          error: 'execution outcome is missing its executor account; cannot verify emitter',
        });
        continue;
      }
      if (executorAccountId !== accountId) continue;

      if (typeof executionOutcomeId !== 'string' || !executionOutcomeId
        || !Number.isSafeInteger(blockHeight) || blockHeight < 0
        || typeof blockHash !== 'string' || !blockHash) {
        quarantined.push({
          ...quarantineWithoutBlockMetadata({
            transactionHash, executionOutcomeId, receiptId, executorAccountId, logIndex, rawLog, blockHeight,
          }),
          executionStatus: outcome.status ?? null,
        });
        continue;
      }

      const message = {
        block: { header: { height: blockHeight, hash: blockHash } },
        shards: [{
          shard_id: null,
          receipt_execution_outcomes: [{ receipt, execution_outcome: execution }],
        }],
      };
      const indexed = indexNearLakeBlock(message, { accountFilter: [accountId] });
      for (const event of indexed.events) {
        events.push({
          ...event,
          transactionHash,
          receiptId,
          executionStatus: outcome.status ?? null,
        });
      }
      for (const event of indexed.quarantined) {
        quarantined.push({
          ...event,
          transactionHash,
          receiptId,
          executionStatus: outcome.status ?? null,
        });
      }
    }
  }

  return { events, quarantined };
}

/** Fetch one account-event page and hydrate its transaction/receipt execution logs. */
export async function readFastNearEventLogPage({
  accountId,
  resumeToken,
  limit = 20,
  apiKey = process.env.FASTNEAR_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  validatePageOptions({ accountId, resumeToken, limit });
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const headers = { 'content-type': 'application/json' };
  if (typeof apiKey === 'string' && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

  const accountQuery = {
    account_id: accountId,
    is_event_log: true,
    desc: false,
    limit,
  };
  if (resumeToken) accountQuery.resume_token = resumeToken;

  const accountPage = await postJson(
    fetchImpl,
    `${API_BASE_URL}/v0/account`,
    accountQuery,
    headers,
    'account history',
  );
  if (!accountPage || !Array.isArray(accountPage.account_txs)) {
    throw new TypeError('FastNear account response is missing account_txs');
  }
  if (accountPage.resume_token !== null && accountPage.resume_token !== undefined
    && typeof accountPage.resume_token !== 'string') {
    throw new TypeError('FastNear account response has an invalid resume_token');
  }
  const validRows = accountPage.account_txs.filter((row) =>
    row?.account_id === accountId && row?.is_event_log === true
      && typeof row.transaction_hash === 'string' && row.transaction_hash.length > 0);
  const rejectedAccountRows = accountPage.account_txs.length - validRows.length;
  const requestedHashes = [...new Set(validRows.map((row) => row.transaction_hash))];
  const transactionMap = new Map();

  for (let offset = 0; offset < requestedHashes.length; offset += TRANSACTION_BATCH_SIZE) {
    const txHashes = requestedHashes.slice(offset, offset + TRANSACTION_BATCH_SIZE);
    const transactionPage = await postJson(
      fetchImpl,
      `${API_BASE_URL}/v0/transactions`,
      { tx_hashes: txHashes },
      headers,
      'transaction lookup',
    );
    if (!transactionPage || !Array.isArray(transactionPage.transactions)) {
      throw new TypeError('FastNear transaction response is missing transactions');
    }
    for (const transaction of transactionPage.transactions) {
      const hash = transaction?.transaction?.hash;
      if (typeof hash !== 'string' || !hash) throw new TypeError('FastNear transaction response contains a transaction without a hash');
      transactionMap.set(hash, transaction);
    }
  }

  const missingTransactionHashes = requestedHashes.filter((hash) => !transactionMap.has(hash));
  const orderedTransactions = [
    ...requestedHashes.map((hash) => transactionMap.get(hash)).filter(Boolean),
    ...[...transactionMap.entries()]
      .filter(([hash]) => !requestedHashes.includes(hash))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, transaction]) => transaction),
  ];

  const eventMap = new Map();
  const quarantineMap = new Map();
  for (const transaction of orderedTransactions) {
    const parsed = parseTransactionEvents(transaction, accountId);
    for (const event of parsed.events) eventMap.set(event.eventId, event);
    for (const event of parsed.quarantined) quarantineMap.set(event.eventId, event);
  }
  const sortByChainPosition = (left, right) =>
    (left.blockHeight ?? Number.MAX_SAFE_INTEGER) - (right.blockHeight ?? Number.MAX_SAFE_INTEGER)
      || left.eventId.localeCompare(right.eventId);
  const events = [...eventMap.values()].sort(sortByChainPosition);
  const quarantined = [...quarantineMap.values()].sort(sortByChainPosition);
  const nextResumeToken = accountPage.resume_token || null;
  const pageStatus = missingTransactionHashes.length > 0 || rejectedAccountRows > 0 || quarantined.length > 0
    ? 'partial'
    : 'page_processed';

  return {
    schemaVersion: '1.0',
    inputFormat: 'fastnear-transactions-api',
    accountId,
    query: { isEventLog: true, oldestFirst: true, limit, resumeToken: resumeToken ?? null },
    accountRowsReceived: accountPage.account_txs.length,
    rejectedAccountRows,
    transactionsRequested: requestedHashes.length,
    transactionsHydrated: requestedHashes.length - missingTransactionHashes.length,
    missingTransactionHashes,
    nextResumeToken,
    hasMore: Boolean(nextResumeToken),
    pageStatus,
    events,
    quarantined,
    semantics: 'One indexed account-event page only. Events are filtered to the exact emitting account; logs are observations, not proof of successful settlement, payout, or financial classification. No KI persistence is performed.',
  };
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function executionStatusName(outcome) {
  const status = outcome?.status;
  if (typeof status === 'string') {
    return ['SuccessValue', 'SuccessReceiptId', 'Failure'].includes(status) ? status : null;
  }
  if (!isRecord(status)) return null;

  const keys = Object.keys(status);
  if (keys.length !== 1) return null;
  const [variant] = keys;
  if (variant === 'SuccessValue' && typeof status[variant] === 'string') return variant;
  if (variant === 'SuccessReceiptId' && typeof status[variant] === 'string' && status[variant].length > 0) return variant;
  if (variant === 'Failure' && isRecord(status[variant])) return variant;
  return null;
}

function hasRecognizedExecutionStatus(outcome) {
  return executionStatusName(outcome) !== null;
}

function isSuccessful(outcome) {
  return ['SuccessValue', 'SuccessReceiptId'].includes(executionStatusName(outcome));
}

function nativeTransferObservation(action, destination, successful, actionIndex, source, diagnostics) {
  const deposit = action.Transfer?.deposit;
  const validDeposit = typeof deposit === 'string' && /^\d+$/.test(deposit);
  const validDestination = typeof destination === 'string' && destination.trim().length > 0;
  if (successful && (!validDeposit || !validDestination)) {
    const missing = [!validDeposit && 'deposit', !validDestination && 'destination'].filter(Boolean).join(' and ');
    diagnostics.push(`${source} native transfer has invalid or missing ${missing}`);
    return {
      type: 'native_transfer', observation: 'incomplete_successful_transfer',
      amount: validDeposit ? deposit : null,
      destination: validDestination ? destination : null,
      actionIndex,
    };
  }
  return successful ? {
    type: 'native_transfer', observation: source === 'root transaction' ? 'successful_transaction_action' : 'successful_receipt_action',
    amount: deposit, destination, actionIndex,
  } : null;
}

function receiptActions(receipt, successful, diagnostics, receiptId) {
  const actions = receipt?.receipt?.Action?.actions;
  if (!Array.isArray(actions)) return [];
  const observed = [];
  for (const [actionIndex, action] of actions.entries()) {
    if (!isRecord(action)) continue;
    if (Object.hasOwn(action, 'Transfer')) {
      const transfer = nativeTransferObservation(action, receipt.receiver_id, successful, actionIndex, `receipt ${receiptId}`, diagnostics);
      if (transfer) observed.push(transfer);
      continue;
    }
    const call = action.FunctionCall;
    if (isRecord(call) && call.method_name === 'ft_transfer') {
      observed.push({ type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' });
    }
  }
  return observed;
}

function transactionActions(transaction, successful, diagnostics) {
  if (!Array.isArray(transaction?.actions)) {
    diagnostics.push('transaction actions must be an array');
    return [];
  }
  const observed = [];
  for (const [actionIndex, action] of transaction.actions.entries()) {
    if (!isRecord(action)) continue;
    if (Object.hasOwn(action, 'Transfer')) {
      const transfer = nativeTransferObservation(action, transaction.receiver_id, successful, actionIndex, 'root transaction', diagnostics);
      if (transfer) observed.push(transfer);
      continue;
    }
    const call = action.FunctionCall;
    if (isRecord(call) && call.method_name === 'ft_transfer') {
      observed.push({ type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' });
    }
  }
  return observed;
}

function rootProvenance(transaction, execution, actions) {
  return {
    outcomeId: execution?.id ?? null,
    blockHeight: Number.isSafeInteger(execution?.block_height) ? execution.block_height : null,
    blockHash: typeof execution?.block_hash === 'string' ? execution.block_hash : null,
    executionStatus: execution?.outcome?.status ?? null,
    executionStatusName: executionStatusName(execution?.outcome),
    logs: Array.isArray(execution?.outcome?.logs)
      ? [...execution.outcome.logs]
      : (execution?.outcome?.logs ?? null),
    actions,
  };
}

/** Pure, deterministic observational audit of one FastNear-shaped transaction. */
export function auditNearTransaction(input) {
  if (!isRecord(input)) throw new TypeError('transaction response must be an object');
  const transaction = input.transaction;
  if (!isRecord(transaction)) throw new TypeError('transaction response is missing transaction');
  if (typeof transaction.hash !== 'string' || transaction.hash.length === 0) {
    throw new TypeError('transaction response is missing transaction.hash');
  }
  if (!isRecord(input.execution_outcome) || !isRecord(input.execution_outcome.outcome)) {
    throw new TypeError('transaction response is missing execution_outcome.outcome');
  }

  const diagnostics = [];
  const receiptsValid = Array.isArray(input.receipts);
  const dataReceiptsValid = Array.isArray(input.data_receipts);
  if (!receiptsValid) diagnostics.push('receipts must be an array');
  if (!dataReceiptsValid) diagnostics.push('data_receipts must be an array');

  const rootActions = transactionActions(transaction, isSuccessful(input.execution_outcome.outcome), diagnostics);

  const actionEntries = receiptsValid ? input.receipts : [];
  const dataEntries = dataReceiptsValid ? input.data_receipts : [];
  const actionReceipts = [];
  const dataReceipts = [];
  const receiptIdEntries = [];
  const outcomeIdEntries = [];
  const references = [];
  const malformedCollections = !receiptsValid || !dataReceiptsValid;

  const rootOutcome = input.execution_outcome.outcome;
  if (!hasRecognizedExecutionStatus(rootOutcome)) {
    diagnostics.push('root execution has missing, malformed, or unrecognized status');
  }
  if (typeof input.execution_outcome.id !== 'string' || !input.execution_outcome.id) {
    diagnostics.push('root execution outcome is missing an outcome ID');
  } else if (input.execution_outcome.id !== transaction.hash) {
    diagnostics.push('root execution outcome ID does not match transaction hash');
  }
  if (!Array.isArray(rootOutcome.logs)) diagnostics.push('root outcome logs must be an array');
  if (!Array.isArray(rootOutcome.receipt_ids)) {
    diagnostics.push('root outcome receipt_ids must be an array');
  } else {
    references.push(...rootOutcome.receipt_ids.filter((id) => typeof id === 'string'));
    if (rootOutcome.receipt_ids.some((id) => typeof id !== 'string' || id.length === 0)) diagnostics.push('root outcome receipt_ids contains malformed IDs');
  }

  for (const entry of actionEntries) {
    const receipt = entry?.receipt;
    const execution = entry?.execution_outcome;
    if (!isRecord(receipt) || typeof receipt.receipt_id !== 'string' || !receipt.receipt_id) {
      diagnostics.push('action receipt collection contains an entry without receipt.receipt_id');
      continue;
    }
    const receiptId = receipt.receipt_id;
    receiptIdEntries.push(receiptId);
    if (!Array.isArray(receipt.receipt?.Action?.actions)) {
      diagnostics.push(`action receipt ${receiptId} actions must be an array`);
    }
    const outcome = execution?.outcome;
    if (!isRecord(execution) || !isRecord(outcome)) {
      diagnostics.push(`action receipt ${receiptId} is missing execution_outcome.outcome`);
    } else {
      if (!hasRecognizedExecutionStatus(outcome)) {
        diagnostics.push(`action receipt ${receiptId} has missing, malformed, or unrecognized status`);
      }
      if (typeof execution.id === 'string' && execution.id) outcomeIdEntries.push(execution.id);
      else diagnostics.push(`action receipt ${receiptId} is missing an execution outcome ID`);
      if (!Array.isArray(outcome.logs)) diagnostics.push(`action receipt ${receiptId} outcome logs must be an array`);
      if (!Array.isArray(outcome.receipt_ids)) {
        diagnostics.push(`action receipt ${receiptId} outcome receipt_ids must be an array`);
      } else {
        references.push(...outcome.receipt_ids.filter((id) => typeof id === 'string'));
        if (outcome.receipt_ids.some((id) => typeof id !== 'string' || id.length === 0)) diagnostics.push(`action receipt ${receiptId} outcome receipt_ids contains malformed IDs`);
      }
    }
    actionReceipts.push({
      receiptId,
      predecessorId: receipt.predecessor_id ?? null,
      receiverId: receipt.receiver_id ?? null,
      outcomeId: execution?.id ?? null,
      blockHeight: Number.isSafeInteger(execution?.block_height) ? execution.block_height : null,
      blockHash: typeof execution?.block_hash === 'string' ? execution.block_hash : null,
      executionStatus: outcome?.status ?? null,
      executionStatusName: executionStatusName(outcome),
      logs: Array.isArray(outcome?.logs) ? [...outcome.logs] : (outcome?.logs ?? null),
      actions: receiptActions(receipt, isSuccessful(outcome), diagnostics, receiptId),
    });
  }

  const actionDiagnosticCount = diagnostics.length - (dataReceiptsValid ? 0 : 1);
  const dataReceiptIds = new Set();
  for (const entry of dataEntries) {
    const data = entry?.receipt?.Data;
    if (!isRecord(entry) || typeof entry.receipt_id !== 'string' || !entry.receipt_id
      || !isRecord(entry.receipt) || !isRecord(data)
      || typeof data.data_id !== 'string' || !data.data_id) {
      diagnostics.push('data receipt collection contains a malformed FastNear Data receipt');
      continue;
    }
    if (dataReceiptIds.has(entry.receipt_id)) {
      diagnostics.push(`data receipt collection contains duplicate receipt ID ${entry.receipt_id}`);
      continue;
    }
    dataReceiptIds.add(entry.receipt_id);
    dataReceipts.push({
      receiptId: entry.receipt_id,
      predecessorId: entry.predecessor_id ?? null,
      receiverId: entry.receiver_id ?? null,
      blockHeight: Number.isSafeInteger(entry.block_height) ? entry.block_height : null,
      blockHash: typeof entry.block_hash === 'string' ? entry.block_hash : null,
      dataId: data.data_id,
      isPromiseResume: typeof data.is_promise_resume === 'boolean' ? data.is_promise_resume : null,
    });
  }

  const counts = (items) => {
    const map = new Map();
    for (const id of items) map.set(id, (map.get(id) ?? 0) + 1);
    return map;
  };
  const receiptCounts = counts(receiptIdEntries);
  const outcomeCounts = counts(outcomeIdEntries);
  const referenceCounts = counts(references);
  const duplicateIds = [...new Set([
    ...[...receiptCounts].filter(([, count]) => count > 1).map(([id]) => id),
    ...[...outcomeCounts].filter(([, count]) => count > 1).map(([id]) => id),
    ...[...referenceCounts].filter(([, count]) => count > 1).map(([id]) => id),
  ])].sort();
  const mismatchedIds = actionReceipts
    .filter((receipt) => receipt.outcomeId !== receipt.receiptId)
    .map((receipt) => ({ receiptId: receipt.receiptId, outcomeId: receipt.outcomeId }));
  const knownReceiptIds = new Set(receiptIdEntries);
  const missingIds = [...new Set(references.filter((id) => !knownReceiptIds.has(id)))].sort();
  const referencedIds = new Set(references);
  const orphanIds = [...knownReceiptIds].filter((id) => !referencedIds.has(id)).sort();
  const graphComplete = missingIds.length === 0 && duplicateIds.length === 0
    && mismatchedIds.length === 0 && orphanIds.length === 0 && actionDiagnosticCount === 0;

  return {
    schemaVersion: '1.0',
    inputFormat: 'fastnear-transaction',
    status: graphComplete && diagnostics.length === 0 && !malformedCollections ? 'complete' : 'partial',
    transaction: {
      hash: transaction.hash,
      signerId: transaction.signer_id ?? null,
      receiverId: transaction.receiver_id ?? null,
      status: input.status ?? null,
    },
    rootExecution: rootProvenance(transaction, input.execution_outcome, rootActions),
    actionReceipts,
    dataReceipts,
    graph: { complete: graphComplete, missingIds, duplicateIds, mismatchedIds, orphanIds },
    diagnostics,
    semantics: 'Observational transaction and receipt execution evidence only. Function-call labels are calls, not proof of token transfer. This report does not verify payout, tax, or rewards completion.',
  };
}

/** Retrieve exactly one matching transaction from FastNear and audit it observationally. */
export async function readFastNearTransactionAudit({
  transactionHash,
  apiKey = process.env.FASTNEAR_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof transactionHash !== 'string' || transactionHash.trim().length === 0
    || transactionHash.trim() !== transactionHash) {
    throw new TypeError('transactionHash must be a non-empty string without surrounding whitespace');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation must be a function');

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl('https://tx.main.fastnear.com/v0/transactions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tx_hashes: [transactionHash] }),
  });
  if (!response?.ok) {
    throw new Error(`FastNear transaction lookup failed with HTTP ${response?.status ?? 'unknown'}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('FastNear transaction lookup returned invalid JSON');
  }
  if (!isRecord(body) || !Array.isArray(body.transactions)) {
    throw new Error('FastNear response transactions must be an array');
  }

  const matches = body.transactions.filter((item) => item?.transaction?.hash === transactionHash);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'FastNear response has no matching transaction'
      : 'FastNear response must contain exactly one matching transaction');
  }
  return auditNearTransaction(matches[0]);
}

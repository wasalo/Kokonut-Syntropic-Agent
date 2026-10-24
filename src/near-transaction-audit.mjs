const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function executionStatusName(outcome) {
  const status = outcome?.status;
  if (typeof status === 'string') return status;
  if (isRecord(status)) return Object.keys(status)[0] ?? null;
  return null;
}

function isSuccessful(outcome) {
  return executionStatusName(outcome)?.startsWith('Success') ?? false;
}

function receiptActions(receipt, successful) {
  const actions = receipt?.receipt?.Action?.actions;
  if (!Array.isArray(actions)) return [];
  const observed = [];
  for (const action of actions) {
    if (!isRecord(action)) continue;
    if (Object.hasOwn(action, 'Transfer')) {
      if (successful) observed.push({ type: 'native_transfer', observation: 'successful_receipt_action' });
      continue;
    }
    const call = action.FunctionCall;
    if (isRecord(call) && call.method_name === 'ft_transfer') {
      observed.push({ type: 'function_call', methodName: 'ft_transfer', observation: 'call_only_not_transfer_proof' });
    }
  }
  return observed;
}

function rootProvenance(transaction, execution) {
  return {
    outcomeId: execution?.id ?? null,
    blockHeight: Number.isSafeInteger(execution?.block_height) ? execution.block_height : null,
    blockHash: typeof execution?.block_hash === 'string' ? execution.block_hash : null,
    executionStatus: execution?.outcome?.status ?? null,
    executionStatusName: executionStatusName(execution?.outcome),
    logs: Array.isArray(execution?.outcome?.logs)
      ? [...execution.outcome.logs]
      : (execution?.outcome?.logs ?? null),
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

  const actionEntries = receiptsValid ? input.receipts : [];
  const dataEntries = dataReceiptsValid ? input.data_receipts : [];
  const actionReceipts = [];
  const dataReceipts = [];
  const receiptIdEntries = [];
  const outcomeIdEntries = [];
  const references = [];
  const malformedCollections = !receiptsValid || !dataReceiptsValid;

  const rootOutcome = input.execution_outcome.outcome;
  if (typeof input.execution_outcome.id !== 'string' || !input.execution_outcome.id) {
    diagnostics.push('root execution outcome is missing an outcome ID');
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
      actions: receiptActions(receipt, isSuccessful(outcome)),
    });
  }

  for (const entry of dataEntries) {
    const receipt = entry?.receipt;
    if (!isRecord(receipt) || typeof receipt.receipt_id !== 'string' || !receipt.receipt_id) {
      diagnostics.push('data receipt collection contains an entry without receipt.receipt_id');
      continue;
    }
    receiptIdEntries.push(receipt.receipt_id);
    dataReceipts.push({
      receiptId: receipt.receipt_id,
      predecessorId: receipt.predecessor_id ?? null,
      receiverId: receipt.receiver_id ?? null,
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
    && mismatchedIds.length === 0 && orphanIds.length === 0 && diagnostics.length === 0;

  return {
    schemaVersion: '1.0',
    inputFormat: 'fastnear-transaction',
    status: graphComplete && !malformedCollections ? 'complete' : 'partial',
    transaction: {
      hash: transaction.hash,
      signerId: transaction.signer_id ?? null,
      receiverId: transaction.receiver_id ?? null,
      status: input.status ?? null,
    },
    rootExecution: rootProvenance(transaction, input.execution_outcome),
    actionReceipts,
    dataReceipts,
    graph: { complete: graphComplete, missingIds, duplicateIds, mismatchedIds, orphanIds },
    diagnostics,
    semantics: 'Observational transaction and receipt execution evidence only. Function-call labels are calls, not proof of token transfer. This report does not verify payout, tax, or rewards completion.',
  };
}

const RPC_ENDPOINT = 'https://rpc.mainnet.near.org';
const FACTORY_ACCOUNT = 'nearlytrade.near';
const EXPECTED = Object.freeze({
  creatorShareBps: 6000,
  genesisSupply: '1000000000000000000000000000',
  pairAsset: 'wrap.near',
});
const REQUIRED_READS = 5;

async function rpcRequest(method, params, { endpoint, fetchImpl, id }) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status} for ${method}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`NEAR RPC ${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  if (!Object.hasOwn(payload, 'result')) throw new Error(`NEAR RPC ${method} returned no result`);
  return payload.result;
}

async function readView({ method, blockHash, endpoint, fetchImpl }) {
  const result = await rpcRequest('query', {
    request_type: 'call_function',
    block_id: blockHash,
    account_id: FACTORY_ACCOUNT,
    method_name: method,
    args_base64: Buffer.from('{}').toString('base64'),
  }, { endpoint, fetchImpl, id: `near-view-${method}` });
  if (!Array.isArray(result.result)) throw new Error(`NEAR RPC ${method} returned malformed view bytes`);
  let text;
  try {
    text = new TextDecoder().decode(Uint8Array.from(result.result));
    return { value: JSON.parse(text), blockHash: result.block_hash, blockHeight: result.block_height };
  } catch (error) {
    throw new Error(`Could not decode Nearly ${method} response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read a consistent, final-block snapshot of public Nearly factory state; no transaction is sent. */
export async function readNearlyFactorySnapshot({ endpoint = RPC_ENDPOINT, fetchImpl = fetch } = {}) {
  const block = await rpcRequest('block', { finality: 'final' }, { endpoint, fetchImpl, id: 'near-final-block' });
  const blockHash = block?.header?.hash;
  const blockHeight = block?.header?.height;
  if (typeof blockHash !== 'string' || !Number.isSafeInteger(blockHeight)) {
    throw new Error('NEAR RPC returned an invalid final block reference');
  }

  const [code, config, shareBounds, quotes, launchCount] = await Promise.all([
    rpcRequest('query', {
      request_type: 'view_code', block_id: blockHash, account_id: FACTORY_ACCOUNT,
    }, { endpoint, fetchImpl, id: 'nearly-factory-code' }),
    readView({ method: 'get_config', blockHash, endpoint, fetchImpl }),
    readView({ method: 'get_creator_share_bounds', blockHash, endpoint, fetchImpl }),
    readView({ method: 'get_quotes', blockHash, endpoint, fetchImpl }),
    readView({ method: 'get_num_launches', blockHash, endpoint, fetchImpl }),
  ]);

  const sourceBlockHashes = [code.block_hash, config.blockHash, shareBounds.blockHash, quotes.blockHash, launchCount.blockHash];
  return {
    factoryAccount: FACTORY_ACCOUNT,
    block: { height: blockHeight, hash: blockHash },
    codeHash: code.hash,
    config: config.value,
    creatorShareBounds: shareBounds.value,
    quotes: quotes.value,
    launchCount: launchCount.value,
    sourceBlockHashes,
  };
}

function check(id, status, expected, observed, message) {
  return { id, status, expected, observed, message };
}

/** Compare observed public factory state with the contract-aligned model; this report never grants launch approval. */
export function evaluateNearlyFactorySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('factory snapshot must be an object');
  const checks = [];
  const factoryMatches = snapshot.factoryAccount === FACTORY_ACCOUNT;
  checks.push(check(
    'factory_account', factoryMatches ? 'pass' : 'blocker', FACTORY_ACCOUNT,
    snapshot.factoryAccount ?? null,
    factoryMatches ? 'Observed the expected Nearly factory account.' : 'Unexpected factory account; reject this snapshot.',
  ));
  const sourceHashes = snapshot.sourceBlockHashes;
  const sameBlock = Array.isArray(sourceHashes) && sourceHashes.length === REQUIRED_READS &&
    typeof snapshot.block?.hash === 'string' && sourceHashes.every((hash) => hash === snapshot.block.hash);
  checks.push(check(
    'snapshot_consistency', sameBlock ? 'pass' : 'blocker',
    `all ${REQUIRED_READS} reads pinned to ${snapshot.block?.hash ?? 'one final block'}`,
    sourceHashes ?? null,
    sameBlock ? 'Factory data and code were read at one final block.' : 'Read set is incomplete or not pinned to one block; do not use this snapshot for readiness.',
  ));

  const codeHashValid = typeof snapshot.codeHash === 'string' && snapshot.codeHash.length > 0;
  checks.push(check(
    'factory_code_hash', codeHashValid ? 'manual_review' : 'blocker',
    'observed code hash compared with an independently approved baseline',
    snapshot.codeHash ?? null,
    codeHashValid ? 'Observed code hash is recorded, but no approved audit/baseline hash is configured.' : 'Factory code hash is missing.',
  ));

  const shareBounds = snapshot.creatorShareBounds;
  const shareMatches = snapshot.config?.creator_fee_share_bps === EXPECTED.creatorShareBps &&
    Array.isArray(shareBounds) && shareBounds.length === 2 &&
    shareBounds[0] <= EXPECTED.creatorShareBps && EXPECTED.creatorShareBps <= shareBounds[1];
  checks.push(check(
    'creator_pool_fee_share', shareMatches ? 'pass' : 'blocker',
    { configured_bps: EXPECTED.creatorShareBps, allowed_bounds_include_bps: EXPECTED.creatorShareBps },
    { configured: snapshot.config?.creator_fee_share_bps ?? null, allowed_bounds: shareBounds ?? null },
    shareMatches ? 'Factory matches the contract-verified creator pool-fee share.' : 'Live factory pool-fee creator share differs from the contract-aligned model or its allowed bounds; reconcile before proceeding.',
  ));

  const supplyMatches = snapshot.config?.total_supply === EXPECTED.genesisSupply;
  checks.push(check(
    'factory_genesis_supply_parameter', supplyMatches ? 'pass' : 'blocker',
    EXPECTED.genesisSupply,
    snapshot.config?.total_supply ?? null,
    supplyMatches ? 'Factory supply parameter matches the PRD reference.' : 'Factory supply parameter differs from the PRD reference.',
  ));

  const nearQuote = Array.isArray(snapshot.quotes)
    ? snapshot.quotes.find(([asset]) => asset === EXPECTED.pairAsset)?.[1]
    : undefined;
  const pairEnabled = nearQuote?.enabled === true;
  checks.push(check(
    'near_pair', pairEnabled ? 'pass' : 'blocker',
    { asset: EXPECTED.pairAsset, enabled: true },
    nearQuote ?? null,
    pairEnabled ? 'The NEAR pair asset is enabled in factory quote configuration.' : 'The expected NEAR pair asset is missing or disabled.',
  ));

  checks.push(check('legal_issuer', 'manual_review', 'Named and approved NEAR issuer/operator', null, 'Not verifiable from factory state.'));
  checks.push(check('beneficiary_routing', 'manual_review', 'Governed mission recipient and actual payout routing verified', null, 'Creator/beneficiary routing must be confirmed before any launch.'));
  checks.push(check('legal_security_signoff', 'manual_review', 'Documented legal, security, and corporate approvals', null, 'Approvals are outside this read-only chain check.'));
  checks.push(check('tax_payload', 'manual_review', 'Signed launch payload matches 300/300 and 8000/1000/1000 bps', null, 'Tax settings are launch-specific and are not proven by factory configuration.'));
  checks.push(check('token_state', 'manual_review', 'Launched token, supply, immutability, and LP lock independently verified', null, 'No token-specific launch state is checked by this prelaunch factory snapshot.'));

  const blocked = checks.some(({ status }) => status === 'blocker');
  return {
    schemaVersion: '1.0',
    status: blocked ? 'blocked' : 'manual_review_required',
    launchAuthorized: false,
    factory: {
      account: snapshot.factoryAccount,
      codeHash: snapshot.codeHash ?? null,
      block: snapshot.block ?? null,
      launchCount: snapshot.launchCount ?? null,
      config: snapshot.config ?? null,
    },
    checks,
    disclaimer: 'Read-only factory observation only. This report is not a launch authorization, security audit, or legal approval.',
  };
}

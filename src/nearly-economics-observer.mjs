const RPC_ENDPOINT = 'https://rpc.mainnet.near.org';
const FACTORY_ACCOUNT = 'nearlytrade.near';
const EXCHANGE_ACCOUNT = 'dclv2.ref-labs.near';
const ACCOUNT_ID_PATTERN = /^(?=.{2,64}$)[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const BASE_UNITS_PATTERN = /^(0|[1-9][0-9]*)$/;

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

function assertPinned(result, blockHash, method) {
  if (result?.block_hash !== blockHash) {
    throw new Error(`${method} response is not pinned to the requested final block`);
  }
}

async function readView({ accountId, method, args = {}, blockHash, endpoint, fetchImpl }) {
  const result = await rpcRequest('query', {
    request_type: 'call_function',
    block_id: blockHash,
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  }, { endpoint, fetchImpl, id: `nearly-${accountId}-${method}` });
  if (result?.error) throw new Error(`NEAR RPC ${method} failed: ${result.error}`);
  if (!Array.isArray(result?.result)) throw new Error(`NEAR RPC ${method} returned malformed view bytes`);
  assertPinned(result, blockHash, method);
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
  } catch (error) {
    throw new Error(`Could not decode Nearly ${method} response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readCode({ accountId, blockHash, endpoint, fetchImpl }) {
  const result = await rpcRequest('query', {
    request_type: 'view_code', block_id: blockHash, account_id: accountId,
  }, { endpoint, fetchImpl, id: `nearly-code-${accountId}` });
  assertPinned(result, blockHash, `view_code(${accountId})`);
  if (typeof result.hash !== 'string' || !result.hash) {
    throw new Error(`NEAR RPC returned no code hash for ${accountId}`);
  }
  return result.hash;
}

function decimalsFor(asset, tokenAccount, tokenDecimals, quoteRows) {
  if (asset === tokenAccount) return tokenDecimals;
  const row = Array.isArray(quoteRows) ? quoteRows.find(([account]) => account === asset) : null;
  return Number.isInteger(row?.[1]?.decimals) ? row[1].decimals : null;
}

/** Read a Nearly launch's current public state at one finalized NEAR block; no transaction is sent. */
export async function readNearlyEconomicsSnapshot(launchId, {
  endpoint = RPC_ENDPOINT,
  fetchImpl = fetch,
} = {}) {
  if (typeof launchId !== 'string' || !BASE_UNITS_PATTERN.test(launchId)) {
    throw new TypeError('launch ID must be a non-negative integer string without leading zeros');
  }

  const block = await rpcRequest('block', { finality: 'final' }, { endpoint, fetchImpl, id: 'near-final-block' });
  const blockHash = block?.header?.hash;
  const blockHeight = block?.header?.height;
  if (typeof blockHash !== 'string' || !Number.isSafeInteger(blockHeight)) {
    throw new Error('NEAR RPC returned an invalid final block reference');
  }

  const [factoryCodeHash, factoryConfig, launch, feeOptions, tax, lockerAccount, quotes] = await Promise.all([
    readCode({ accountId: FACTORY_ACCOUNT, blockHash, endpoint, fetchImpl }),
    readView({ accountId: FACTORY_ACCOUNT, method: 'get_config', blockHash, endpoint, fetchImpl }),
    readView({ accountId: FACTORY_ACCOUNT, method: 'get_launch', args: { launch_id: launchId }, blockHash, endpoint, fetchImpl }),
    readView({ accountId: FACTORY_ACCOUNT, method: 'get_fee_opts', args: { launch_id: launchId }, blockHash, endpoint, fetchImpl }),
    readView({ accountId: FACTORY_ACCOUNT, method: 'get_tax', args: { launch_id: launchId }, blockHash, endpoint, fetchImpl }),
    readView({ accountId: FACTORY_ACCOUNT, method: 'get_locker_for', args: { launch_id: launchId }, blockHash, endpoint, fetchImpl }),
    readView({ accountId: FACTORY_ACCOUNT, method: 'get_quotes', blockHash, endpoint, fetchImpl }),
  ]);

  if (!launch || typeof launch !== 'object' || String(launch.id) !== launchId) {
    throw new Error(`factory launch record does not match requested launch ID ${launchId}`);
  }
  if (typeof launch.token !== 'string' || !ACCOUNT_ID_PATTERN.test(launch.token)) {
    throw new Error(`factory launch ${launchId} contains an invalid token account`);
  }
  if (lockerAccount !== null && (typeof lockerAccount !== 'string' || !ACCOUNT_ID_PATTERN.test(lockerAccount))) {
    throw new Error(`factory launch ${launchId} contains an invalid locker account`);
  }

  const hasPosition = typeof launch.lpt_id === 'string' && launch.lpt_id.length > 0;
  const hasLocker = typeof lockerAccount === 'string';
  const [tokenCodeHash, tokenMetadata, tokenTotalSupply, lockerCodeHash, exchangeReads] = await Promise.all([
    readCode({ accountId: launch.token, blockHash, endpoint, fetchImpl }),
    readView({ accountId: launch.token, method: 'ft_metadata', blockHash, endpoint, fetchImpl }),
    readView({ accountId: launch.token, method: 'ft_total_supply', blockHash, endpoint, fetchImpl }),
    hasLocker ? readCode({ accountId: lockerAccount, blockHash, endpoint, fetchImpl }) : null,
    hasPosition
      ? Promise.all([
          readCode({ accountId: EXCHANGE_ACCOUNT, blockHash, endpoint, fetchImpl }),
          readView({ accountId: EXCHANGE_ACCOUNT, method: 'get_liquidity', args: { lpt_id: launch.lpt_id }, blockHash, endpoint, fetchImpl }),
        ])
      : null,
  ]);

  if (!tokenMetadata || !Number.isInteger(tokenMetadata.decimals) || tokenMetadata.decimals < 0 || tokenMetadata.decimals > 255) {
    throw new Error(`token ${launch.token} returned invalid NEP-141 metadata`);
  }
  if (typeof tokenTotalSupply !== 'string' || !BASE_UNITS_PATTERN.test(tokenTotalSupply)) {
    throw new Error(`token ${launch.token} returned an invalid total supply`);
  }

  const exchangeCodeHash = exchangeReads?.[0] ?? null;
  const position = exchangeReads?.[1] ?? null;
  if (position && (position.lpt_id !== launch.lpt_id || position.pool_id !== launch.pool_id)) {
    throw new Error('Rhea position does not match the factory launch record');
  }
  if (position && (!BASE_UNITS_PATTERN.test(position.unclaimed_fee_x) || !BASE_UNITS_PATTERN.test(position.unclaimed_fee_y))) {
    throw new Error('Rhea position returned malformed unclaimed fee amounts');
  }

  const quoteAsset = typeof launch.quote === 'string' ? launch.quote : null;
  const quoteDecimals = quoteAsset ? decimalsFor(quoteAsset, launch.token, tokenMetadata.decimals, quotes) : null;
  const pendingFees = position && typeof launch.token_is_x === 'boolean'
    ? [
        {
          asset: launch.token_is_x ? launch.token : quoteAsset,
          amountBaseUnits: launch.token_is_x ? position.unclaimed_fee_x : position.unclaimed_fee_y,
          decimals: launch.token_is_x ? tokenMetadata.decimals : quoteDecimals,
        },
        {
          asset: launch.token_is_x ? quoteAsset : launch.token,
          amountBaseUnits: launch.token_is_x ? position.unclaimed_fee_y : position.unclaimed_fee_x,
          decimals: launch.token_is_x ? quoteDecimals : tokenMetadata.decimals,
        },
      ]
    : null;

  return {
    schemaVersion: '1.0',
    observationType: 'nearly_launch_state',
    block: { height: blockHeight, hash: blockHash },
    factory: { account: FACTORY_ACCOUNT, codeHash: factoryCodeHash, config: factoryConfig },
    launch: {
      id: launch.id,
      tokenAccount: launch.token,
      creator: launch.creator ?? null,
      name: launch.name ?? null,
      symbol: launch.symbol ?? null,
      createdAtMs: launch.created_at_ms ?? null,
      status: launch.step ?? null,
      quoteAsset,
      poolId: launch.pool_id ?? null,
      tokenIsX: typeof launch.token_is_x === 'boolean' ? launch.token_is_x : null,
      lptId: launch.lpt_id ?? null,
      feeOptions,
      feeTotals: {
        near: launch.fees_near_total ?? null,
        token: launch.fees_token_total ?? null,
        quote: launch.fees_quote_total ?? null,
        creatorToken: launch.creator_token_fees ?? null,
        creatorQuote: launch.creator_quote_fees ?? null,
      },
      tax,
      lockerAccount,
    },
    token: {
      account: launch.token,
      codeHash: tokenCodeHash,
      metadata: tokenMetadata,
      totalSupply: tokenTotalSupply,
    },
    poolPosition: position ? {
      contract: EXCHANGE_ACCOUNT,
      codeHash: exchangeCodeHash,
      lptId: position.lpt_id,
      poolId: position.pool_id,
      ownerId: position.owner_id ?? null,
      unclaimedFees: pendingFees,
    } : null,
    locker: hasLocker ? { account: lockerAccount, codeHash: lockerCodeHash } : null,
    integrity: {
      lockerOwnsPosition: position && hasLocker ? position.owner_id === lockerAccount : null,
      positionMatchesLaunch: position ? position.lpt_id === launch.lpt_id && position.pool_id === launch.pool_id : null,
    },
    history: {
      indexed: false,
      message: 'Point-in-time contract views only; historical events, completed payouts, and beneficiary control are not verified by this snapshot.',
    },
    launchAuthorized: false,
  };
}

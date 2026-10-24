const EXPECTED = Object.freeze({
  launchpad: 'nearly.trade',
  network: 'near:mainnet',
  pair_asset: 'wrap.near',
  creator_share_bps: 6000,
  tax: Object.freeze({
    buy_bps: 300,
    sell_bps: 300,
    creator_bps: 8000,
    holders_bps: 1000,
    burn_bps: 1000,
  }),
});

const PLACEHOLDERS = Object.freeze({
  creator_account: '<verify-governed-recipient-and-factory-caller>',
  ticker: 'TBD',
});

/**
 * Validate the contract-aligned Nearly configuration model only.
 * This does not query or verify Nearly contracts and never authorizes a launch.
 * @param {unknown} input
 * @returns {string[]} Human-readable validation issues; empty means model-conformant.
 */
export function validateNearlyLaunchConfig(input) {
  const issues = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['config must be an object'];
  }

  const allowedFields = new Set([
    'launchpad', 'network', 'pair_asset', 'creator_share_bps', 'tax',
    'token_name', 'ticker', 'creator_account', 'launch_id', 'token_account',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) issues.push(`unknown field: ${key}`);
  }

  if (input.launchpad !== EXPECTED.launchpad) issues.push(`launchpad must be ${EXPECTED.launchpad}`);
  if (input.network !== EXPECTED.network) issues.push(`network must be ${EXPECTED.network}`);
  if (input.pair_asset !== EXPECTED.pair_asset) issues.push(`pair_asset must be ${EXPECTED.pair_asset}`);
  if (input.creator_share_bps !== EXPECTED.creator_share_bps) {
    issues.push(`creator_share_bps must match the contract-aligned model value ${EXPECTED.creator_share_bps}; rerun live factory verification before any launch`);
  }

  if (!input.tax || typeof input.tax !== 'object' || Array.isArray(input.tax)) {
    issues.push('tax must be an object');
  } else {
    for (const key of Object.keys(input.tax)) {
      if (!Object.hasOwn(EXPECTED.tax, key)) issues.push(`unknown tax field: ${key}`);
    }
    for (const [key, expected] of Object.entries(EXPECTED.tax)) {
      if (input.tax[key] !== expected) issues.push(`tax.${key} must be ${expected}`);
    }
    const weights = ['creator_bps', 'holders_bps', 'burn_bps'];
    if (weights.every((key) => Number.isInteger(input.tax[key])) &&
        weights.reduce((sum, key) => sum + input.tax[key], 0) !== 10_000) {
      issues.push('creator-side tax weights must sum to 10000');
    }
  }

  for (const [key, expected] of Object.entries(PLACEHOLDERS)) {
    if (input[key] !== expected) issues.push(`${key} must remain the unresolved PRD placeholder ${expected}`);
  }
  if (typeof input.token_name !== 'string' || !input.token_name.trim()) {
    issues.push('token_name must be a non-empty provisional display name');
  }
  for (const key of ['launch_id', 'token_account']) {
    if (input[key] !== null) issues.push(`${key} must be null before verified deployment`);
  }

  return issues;
}

/** Expose immutable expected parameters for display/tests; not live chain data. */
export const nearlyLaunchModel = EXPECTED;

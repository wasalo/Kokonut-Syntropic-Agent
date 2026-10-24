const TAX_BPS = 300n;
const TAX_CREATOR_SHARE_BPS = 7000n; // token-tax share, distinct from the factory pool-fee share
const CREATOR_SPLIT = Object.freeze({ mission: 8000n, holders: 1000n, directBurn: 1000n });
const BPS_DENOMINATOR = 10_000n;

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function fraction(numerator, denominator = 1n) {
  const divisor = gcd(numerator, denominator);
  const sign = denominator < 0n ? -1n : 1n;
  return {
    numerator: String((numerator / divisor) * sign),
    denominator: String((denominator / divisor) * sign),
  };
}

function multiply(value, numerator, denominator = BPS_DENOMINATOR) {
  return fraction(BigInt(value.numerator) * numerator, BigInt(value.denominator) * denominator);
}

/**
 * Exact-arithmetic illustration of the PRD's Nearly trade-tax policy.
 * Fractions are returned instead of guessing the deployed contracts' integer rounding.
 * This is not a chain observer, fee quote, or prediction of realized NEAR/USD proceeds.
 * @param {string} taxableAmountUnits Non-negative integer base units, represented as a string.
 */
export function previewNearlyTaxAllocation(taxableAmountUnits) {
  if (typeof taxableAmountUnits !== 'string' || !/^(0|[1-9][0-9]*)$/.test(taxableAmountUnits)) {
    throw new TypeError('taxable amount must be a non-negative integer string');
  }

  const taxable = fraction(BigInt(taxableAmountUnits));
  const taxCollected = multiply(taxable, TAX_BPS);
  const creatorControlled = multiply(taxCollected, TAX_CREATOR_SHARE_BPS);
  const nearlyProtocol = multiply(taxCollected, 2000n);
  const referrals = multiply(taxCollected, 1000n);

  return {
    taxableAmountUnits,
    taxBps: Number(TAX_BPS),
    taxCollected,
    creatorControlled,
    mission: multiply(creatorControlled, CREATOR_SPLIT.mission),
    holders: multiply(creatorControlled, CREATOR_SPLIT.holders),
    directBurn: multiply(creatorControlled, CREATOR_SPLIT.directBurn),
    nearlyProtocol,
    referrals,
  };
}

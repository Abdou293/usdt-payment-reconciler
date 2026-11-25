// Decimal-safe money arithmetic.
// All token amounts are stored as bigint "base units" (USDT has 6 decimals:
// 1 USDT = 1_000_000 units). We never use JavaScript floating point for money,
// because e.g. 0.1 + 0.2 !== 0.3 in floating point.

export const USDT_DECIMALS = 6;

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d+)?$/;

/** Parse a human decimal string like "50.000137" into base units (bigint). */
export function parseAmount(input: string, decimals: number = USDT_DECIMALS): bigint {
  const text = input.trim();
  if (!AMOUNT_PATTERN.test(text)) {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [whole, fractionWithDot = ''] = text.split('.') as [string, string?];
  const fraction = fractionWithDot.replace('.', '');
  if (fraction.length > decimals) {
    throw new Error(`Amount "${input}" has more than ${decimals} decimal places`);
  }
  const paddedFraction = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0');
}

/** Format base units back into a decimal string with exactly `decimals` places. */
export function formatAmount(units: bigint, decimals: number = USDT_DECIMALS): string {
  if (units < 0n) {
    return `-${formatAmount(-units, decimals)}`;
  }
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const fraction = (units % base).toString().padStart(decimals, '0');
  return decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
}

/** Convert a bigint stored as TEXT in the database back to bigint. */
export function unitsFromDb(value: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Corrupt amount in database: "${value}"`);
  }
  return BigInt(value);
}

/**
 * Convert a raw on-chain amount into the system's single internal unit
 * (USDT_DECIMALS = 6). Every network is stored in this one unit, so matching,
 * reports and the dashboard never mix scales.
 *
 * - 6-decimal tokens (TRON, Arbitrum, Ethereum USDT): unchanged.
 * - 18-decimal tokens (BSC "Binance-Peg" USDT): divided by 10^12. Anything
 *   below 0.000001 USDT ("dust") is ROUNDED DOWN, never up, so the system can
 *   never credit more than actually arrived. The dropped dust is returned so
 *   the caller can record it in the audit log.
 */
export function toCanonicalUnits(raw: bigint, tokenDecimals: number): { units: bigint; dust: bigint } {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error(`Unsupported token decimals: ${tokenDecimals}`);
  }
  if (raw < 0n) throw new Error('Negative on-chain amount');
  if (tokenDecimals === USDT_DECIMALS) return { units: raw, dust: 0n };
  if (tokenDecimals < USDT_DECIMALS) {
    return { units: raw * 10n ** BigInt(USDT_DECIMALS - tokenDecimals), dust: 0n };
  }
  const scale = 10n ** BigInt(tokenDecimals - USDT_DECIMALS);
  return { units: raw / scale, dust: raw % scale };
}

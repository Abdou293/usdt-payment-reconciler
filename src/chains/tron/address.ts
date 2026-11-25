// TRON address helpers. TRON addresses are a 0x41-prefixed 20-byte hex value,
// shown to humans in Base58Check ("T..."). Implemented with node:crypto only.

import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** "41" + 40 hex chars (or 40 hex chars without prefix) -> "T..." */
export function tronHexToBase58(hex: string): string {
  let clean = hex.toLowerCase().replace(/^0x/, '');
  if (clean.length === 40) clean = `41${clean}`;
  if (!/^41[0-9a-f]{40}$/.test(clean)) throw new Error(`Invalid TRON hex address: ${hex}`);
  const payload = Buffer.from(clean, 'hex');
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  let n = BigInt(`0x${Buffer.concat([payload, checksum]).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return out;
}

/** "T..." -> "41..." (42 hex chars). Throws on a bad checksum. */
export function tronBase58ToHex(address: string): string {
  let n = 0n;
  for (const char of address) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`Invalid TRON address: ${address}`);
    n = n * 58n + BigInt(value);
  }
  const bytes = Buffer.from(n.toString(16).padStart(50, '0'), 'hex');
  const payload = bytes.subarray(0, 21);
  const checksum = bytes.subarray(21);
  if (!sha256(sha256(payload)).subarray(0, 4).equals(checksum) || payload[0] !== 0x41) {
    throw new Error(`Invalid TRON address checksum: ${address}`);
  }
  return payload.toString('hex');
}

export function isValidTronAddress(address: string): boolean {
  try {
    tronBase58ToHex(address);
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  } catch {
    return false;
  }
}

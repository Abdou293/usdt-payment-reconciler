import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, unitsFromDb } from '../../src/core/money.js';

describe('money (decimal-safe, no floating point)', () => {
  it('parses decimal strings into integer base units', () => {
    expect(parseAmount('1')).toBe(1_000_000n);
    expect(parseAmount('50.000137')).toBe(50_000_137n);
    expect(parseAmount('0.000001')).toBe(1n);
    expect(parseAmount('0')).toBe(0n);
  });

  it('formats base units back to an exact string', () => {
    expect(formatAmount(50_000_137n)).toBe('50.000137');
    expect(formatAmount(1n)).toBe('0.000001');
    expect(formatAmount(-1_500_000n)).toBe('-1.500000');
  });

  it('round-trips without precision loss', () => {
    for (const s of ['0.100000', '999999.999999', '123456789.000001']) {
      expect(formatAmount(parseAmount(s))).toBe(s);
    }
  });

  it('adds 0.1 + 0.2 exactly (floating point would give 0.30000000000000004)', () => {
    expect(formatAmount(parseAmount('0.1') + parseAmount('0.2'))).toBe('0.300000');
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '-1', '1e6', '1.2.3', '01', ' . ', 'NaN', '0x10']) {
      expect(() => parseAmount(bad)).toThrow();
    }
  });

  it('rejects more decimals than the token supports', () => {
    expect(() => parseAmount('1.0000001')).toThrow(/decimal places/);
  });

  it('rejects corrupt database values', () => {
    expect(() => unitsFromDb('12.5')).toThrow();
    expect(unitsFromDb('42')).toBe(42n);
  });
});

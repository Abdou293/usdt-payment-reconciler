import { describe, expect, it } from 'vitest';
import { matchDeposit, sameAddress } from '../../src/core/matcher.js';
import { parseAmount } from '../../src/core/money.js';
import { assertTransition, canTransition } from '../../src/core/stateMachine.js';
import { pickUniquePayableAmount } from '../../src/core/uniqueAmount.js';
import type { Order, TransferEvent } from '../../src/core/types.js';

function order(id: string, payable: string, status: Order['status'] = 'pending', base = '50'): Order {
  return {
    id,
    externalRef: null,
    network: 'simulated',
    token: 'USDT',
    receivingAddress: 'ADDR',
    baseAmount: parseAmount(base),
    payableAmount: parseAmount(payable),
    status,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    payerTelegramChatId: null,
    manuallyResolved: false,
  };
}

function deposit(amount: string, to = 'ADDR'): TransferEvent {
  return {
    network: 'simulated',
    txHash: '0xabc',
    logIndex: 0,
    tokenContract: 'C',
    fromAddress: 'X',
    toAddress: to,
    amount: parseAmount(amount),
    blockNumber: 1,
    blockTimestamp: new Date(),
  };
}

describe('state machine', () => {
  it('allows the normal happy path', () => {
    expect(canTransition('pending', 'detected')).toBe(true);
    expect(canTransition('detected', 'confirming')).toBe(true);
    expect(canTransition('confirming', 'confirmed')).toBe(true);
  });

  it('never lets the system leave a final state', () => {
    for (const to of ['pending', 'expired', 'underpaid', 'detected'] as const) {
      expect(canTransition('confirmed', to)).toBe(false);
    }
  });

  it('allows review resolutions only for an admin', () => {
    expect(canTransition('underpaid', 'confirmed', 'system')).toBe(true); // via top-up payment
    expect(canTransition('overpaid', 'confirmed', 'system')).toBe(false);
    expect(canTransition('overpaid', 'confirmed', 'admin')).toBe(true);
    expect(canTransition('late_payment', 'confirmed', 'system')).toBe(false);
    expect(canTransition('late_payment', 'confirmed', 'admin')).toBe(true);
  });

  it('throws on an illegal transition', () => {
    expect(() => assertTransition('pending', 'confirmed', 'admin')).not.toThrow();
    expect(() => assertTransition('late_payment', 'pending')).toThrow(/Illegal/);
  });
});

describe('unique payable amount', () => {
  it('adds a suffix between 0.000001 and 0.009999', () => {
    const base = parseAmount('50');
    for (let i = 0; i < 200; i++) {
      const payable = pickUniquePayableAmount(base, new Set());
      expect(payable > base).toBe(true);
      expect(payable - base <= 9_999n).toBe(true);
    }
  });

  it('avoids amounts already reserved by other orders', () => {
    const base = parseAmount('10');
    const alwaysOne = () => 1; // force a collision on every random try
    const reserved = new Set([base + 1n, base + 2n]);
    expect(pickUniquePayableAmount(base, reserved, alwaysOne)).toBe(base + 3n);
  });

  it('fails loudly when every slot on the address is taken', () => {
    const base = parseAmount('10');
    const reserved = new Set([base + 1n, base + 2n, base + 3n]);
    expect(() => pickUniquePayableAmount(base, reserved, () => 1, 3)).toThrow(/No unique amount/);
  });
});

describe('matcher', () => {
  it('matches the exact unique amount', () => {
    const result = matchDeposit(deposit('50.000137'), [order('a', '50.000137'), order('b', '50.000201')]);
    expect(result).toEqual({ matched: true, orderId: 'a', reason: 'exact_amount' });
  });

  it('matches a payment that dropped the suffix when only one order has that base', () => {
    const result = matchDeposit(deposit('50'), [order('a', '50.000137'), order('b', '20.000201', 'pending', '20')]);
    expect(result).toEqual({ matched: true, orderId: 'a', reason: 'base_amount' });
  });

  it('is ambiguous when two open orders share the base amount', () => {
    const result = matchDeposit(deposit('50'), [order('a', '50.000137'), order('b', '50.000201')]);
    expect(result).toEqual({ matched: false, reason: 'ambiguous' });
  });

  it('falls back to the only open order on the address', () => {
    const result = matchDeposit(deposit('31.5'), [order('a', '50.000137')]);
    expect(result).toEqual({ matched: true, orderId: 'a', reason: 'only_open_order' });
  });

  it('does not match deposits to a different address', () => {
    expect(matchDeposit(deposit('50.000137', 'OTHER'), [order('a', '50.000137')]).matched).toBe(false);
  });

  it('compares EVM addresses case-insensitively but TRON addresses exactly', () => {
    expect(sameAddress('0xAbC', '0xabc')).toBe(true);
    expect(sameAddress('TAbC', 'Tabc')).toBe(false);
  });
});

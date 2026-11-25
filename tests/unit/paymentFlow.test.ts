// End-to-end flow tests on the simulated chain: orders, matching,
// confirmations and every edge case from the project requirements.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '../../src/core/money.js';
import type { TransferEvent } from '../../src/core/types.js';
import { ValidationError } from '../../src/services/OrderService.js';
import { createHarness, payAndPoll, SIM_ADDRESS, SIM_ADDRESS_2 } from '../helpers.js';

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];
function harness(options?: Parameters<typeof createHarness>[0]): Harness {
  const h = createHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.store.close();
});

async function statusOf(h: Harness, orderId: string) {
  return (await h.store.getOrder(orderId))!.status;
}

describe('happy path', () => {
  it('pending -> detected -> confirming -> confirmed, with audit trail and events', async () => {
    const h = harness();
    await h.watcher.pollOnce(); // first run: cursor starts at the chain tip
    const order = await h.orders.createOrder({ amount: '50', network: 'simulated', externalRef: 'INV-1001' });
    expect(order.status).toBe('pending');
    expect(order.payableAmount).not.toBe(order.baseAmount);

    await payAndPoll(h, SIM_ADDRESS, order.payableAmount);
    expect(await statusOf(h, order.id)).toBe('confirming'); // 1 of 3 confirmations

    h.chain.mine(2);
    await h.watcher.pollOnce();
    expect(await statusOf(h, order.id)).toBe('confirmed');

    expect(h.statusEvents.map((e) => `${e.from}->${e.to}`)).toEqual([
      'pending->detected',
      'detected->confirming',
      'confirming->confirmed',
    ]);
    const audit = await h.store.listAudit('order', order.id);
    expect(audit.map((a) => a.action)).toEqual(['order_created', 'status_changed', 'status_changed', 'status_changed']);
    expect(h.reviewAlerts).toHaveLength(0);
  });
});

describe('idempotency and duplicates', () => {
  it('stores the same transaction (tx hash + log index) only once', async () => {
    const h = harness();
    const order = await h.orders.createOrder({ amount: '20', network: 'simulated' });
    const event: TransferEvent = {
      network: 'simulated',
      txHash: '0xdup',
      logIndex: 0,
      tokenContract: 'SIM-USDT-CONTRACT',
      fromAddress: 'payer',
      toAddress: SIM_ADDRESS,
      amount: order.payableAmount,
      blockNumber: 101,
      blockTimestamp: h.clock.now(),
    };
    const first = await h.processor.ingestTransfer(event);
    const second = await h.processor.ingestTransfer(event);
    const third = await h.processor.ingestTransfer({ ...event });
    expect(first.outcome).toBe('stored');
    expect(second.outcome).toBe('duplicate');
    expect(third.outcome).toBe('duplicate');
    expect(await h.store.listPaymentsForOrder(order.id)).toHaveLength(1);
    expect(await h.store.listAudit('payment', String(first.paymentId))).toHaveLength(1);
  });

  it('overlapping re-scans across many polls never create duplicates', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '20', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, order.payableAmount);
    for (let i = 0; i < 5; i++) {
      h.chain.mine(1);
      await h.watcher.pollOnce();
    }
    expect(await h.store.listPaymentsForOrder(order.id)).toHaveLength(1);
    expect(await statusOf(h, order.id)).toBe('confirmed');
  });

  it('running expiry twice changes the order only once', async () => {
    const h = harness();
    const order = await h.orders.createOrder({ amount: '5', network: 'simulated', expiresInMinutes: 10 });
    h.clock.advanceMinutes(11);
    await h.processor.expireOrders();
    await h.processor.expireOrders();
    const changes = (await h.store.listAudit('order', order.id)).filter((a) => a.action === 'status_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.toStatus).toBe('expired');
  });
});

describe('underpayment and overpayment', () => {
  it('flags an underpayment beyond tolerance for review, then completes with an admin-assigned top-up', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '50', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, parseAmount('40'), 2);
    expect(await statusOf(h, order.id)).toBe('underpaid');
    expect(h.reviewAlerts.some((a) => a.kind === 'order_needs_review' && a.orderId === order.id)).toBe(true);

    // The payer sends the rest. No open order matches, so it lands in the review queue.
    const remaining = order.payableAmount - parseAmount('40');
    await payAndPoll(h, SIM_ADDRESS, remaining, 2);
    const [topUp] = await h.store.listPaymentsByStatus(['unmatched']);
    expect(topUp).toBeDefined();

    await h.processor.assignPaymentManually(topUp!.id, order.id, 'alice', 'Customer confirmed top-up by email');
    expect(await statusOf(h, order.id)).toBe('confirmed');
  });

  it('accepts a small underpayment inside the configured tolerance', async () => {
    const h = harness({ underpayTolerance: '0.01' });
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '50', network: 'simulated' });
    // Payer ignored the unique suffix and sent exactly 50.
    await payAndPoll(h, SIM_ADDRESS, parseAmount('50'), 2);
    const [payment] = await h.store.listPaymentsForOrder(order.id);
    expect(payment!.note).toBe('matched_by:base_amount');
    expect(await statusOf(h, order.id)).toBe('confirmed');
  });

  it('flags an overpayment; only an admin can accept it', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '50', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, parseAmount('60'), 2);
    expect(await statusOf(h, order.id)).toBe('overpaid');

    await h.processor.acceptOrderManually(order.id, 'alice', 'Refunding the extra 10 USDT off-system');
    const resolved = (await h.store.getOrder(order.id))!;
    expect(resolved.status).toBe('confirmed');
    expect(resolved.manuallyResolved).toBe(true);
    const lastAudit = (await h.store.listAudit('order', order.id)).at(-1)!;
    expect(lastAudit).toMatchObject({ action: 'manual_accept', actor: 'admin:alice', fromStatus: 'overpaid' });
  });

  it('refuses a manual accept that the state machine forbids', async () => {
    const h = harness();
    const order = await h.orders.createOrder({ amount: '50', network: 'simulated' });
    h.clock.advanceMinutes(31);
    await h.processor.expireOrders();
    await expect(h.processor.acceptOrderManually(order.id, 'alice', 'no payment at all')).rejects.toThrow(/Illegal/);
    expect(await statusOf(h, order.id)).toBe('expired');
  });
});

describe('expiry and late payments', () => {
  it('expires an unpaid order', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    h.clock.advanceMinutes(31);
    await h.watcher.pollOnce();
    expect(await statusOf(h, order.id)).toBe('expired');
  });

  it('marks a payment made after expiry as late_payment for review', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    h.clock.advanceMinutes(31);
    await h.watcher.pollOnce();
    await payAndPoll(h, SIM_ADDRESS, order.payableAmount, 2);
    expect(await statusOf(h, order.id)).toBe('late_payment');
    expect(h.reviewAlerts.some((a) => a.orderId === order.id)).toBe(true);

    await h.processor.acceptOrderManually(order.id, 'alice', 'Goods still available');
    expect(await statusOf(h, order.id)).toBe('confirmed');
  });

  it('honours an in-time payment even if the server was asleep and expired the order first', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    h.clock.advanceMinutes(10);
    h.chain.sendTransfer({ toAddress: SIM_ADDRESS, amount: order.payableAmount });
    h.chain.mine(3); // mined at minute 10: in time

    h.clock.advanceMinutes(30); // server was asleep, now minute 40
    await h.processor.expireOrders();
    expect(await statusOf(h, order.id)).toBe('expired');

    await h.watcher.pollOnce(); // wakes up and catches up
    expect(await statusOf(h, order.id)).toBe('confirmed');
  });
});

describe('wrong token, wrong network, unmatched', () => {
  it('records a transfer of a different token as wrong_token and leaves the order pending', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    h.chain.sendTransfer({ toAddress: SIM_ADDRESS, amount: order.payableAmount, tokenContract: 'FAKE-USDT' });
    h.chain.mine(3);
    await h.watcher.pollOnce();
    const [payment] = await h.store.listPaymentsByStatus(['wrong_token']);
    expect(payment).toBeDefined();
    expect(await statusOf(h, order.id)).toBe('pending');
    expect(h.reviewAlerts.some((a) => a.kind === 'wrong_token')).toBe(true);
  });

  it('flags a payment on the wrong network with a hint to the intended order', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const tronOrder = await h.orders.createOrder({ amount: '25', network: 'tron' });
    await payAndPoll(h, SIM_ADDRESS, tronOrder.payableAmount);
    const [payment] = await h.store.listPaymentsByStatus(['unmatched']);
    expect(payment!.note).toContain('possible_wrong_network');
    expect(payment!.note).toContain(tronOrder.id);
    expect(await statusOf(h, tronOrder.id)).toBe('pending');
  });

  it('leaves an ambiguous payment unmatched instead of guessing', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const a = await h.orders.createOrder({ amount: '50', network: 'simulated' });
    const b = await h.orders.createOrder({ amount: '50', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, parseAmount('50'));
    const [payment] = await h.store.listPaymentsByStatus(['unmatched']);
    expect(payment!.note).toBe('unmatched:ambiguous');
    expect(await statusOf(h, a.id)).toBe('pending');
    expect(await statusOf(h, b.id)).toBe('pending');
  });
});

describe('chain reorganizations', () => {
  it('returns the order to pending when its payment is removed by a reorg', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, order.payableAmount);
    expect(await statusOf(h, order.id)).toBe('confirming');

    h.chain.reorg(1); // block with the payment disappears
    await h.watcher.pollOnce();
    const [payment] = await h.store.listPaymentsByStatus(['orphaned']);
    expect(payment).toBeDefined();
    expect(await statusOf(h, order.id)).toBe('pending');
  });

  it('restores the payment when the same transaction is mined again', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    const txHash = await payAndPoll(h, SIM_ADDRESS, order.payableAmount);
    h.chain.reorg(1);
    await h.watcher.pollOnce();
    expect(await statusOf(h, order.id)).toBe('pending');

    h.chain.sendTransfer({ toAddress: SIM_ADDRESS, amount: order.payableAmount, txHash });
    h.chain.mine(3);
    await h.watcher.pollOnce();
    expect(await statusOf(h, order.id)).toBe('confirmed');
    expect(await h.store.listPaymentsForOrder(order.id)).toHaveLength(1);
  });

  it('restarts confirmation counting when a reorg moves the transfer to a later block', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    const txHash = await payAndPoll(h, SIM_ADDRESS, order.payableAmount, 1); // 2 confirmations
    expect(await statusOf(h, order.id)).toBe('confirming');

    h.chain.reorg(2); // both blocks replaced, transfer not re-included yet
    h.chain.sendTransfer({ toAddress: SIM_ADDRESS, amount: order.payableAmount, txHash });
    h.chain.mine(1); // now in a later block, 1 confirmation
    await h.watcher.pollOnce();
    const [payment] = await h.store.listPaymentsForOrder(order.id);
    expect(payment!.status).toBe('matched');
    expect(await statusOf(h, order.id)).toBe('confirming');
    const paymentAudit = await h.store.listAudit('payment', String(payment!.id));
    expect(paymentAudit.some((a) => a.action === 'payment_block_changed')).toBe(true);
  });

  it('raises a critical alert (and does not silently un-confirm) for a reorg deeper than the confirmations', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, order.payableAmount, 3);
    expect(await statusOf(h, order.id)).toBe('confirmed');

    h.chain.reorg(4); // removes the payment block AND its 3 confirmations
    await h.watcher.pollOnce();
    expect(await statusOf(h, order.id)).toBe('confirmed');
    expect(h.reviewAlerts.some((a) => a.kind === 'reorg_after_final' && a.orderId === order.id)).toBe(true);
  });
});

describe('restart and catch-up (free hosts that sleep)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('resumes from the saved cursor in a fresh process and misses nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'usdt-recon-'));
    const dbPath = join(dir, 'app.db');

    const first = createHarness({ dbPath, maxBlocksPerPoll: 5 });
    await first.watcher.pollOnce();
    const order = await first.orders.createOrder({ amount: '15', network: 'simulated' });
    first.store.close(); // the server goes to sleep

    // While asleep: many blocks, including our payment.
    first.chain.mine(20);
    first.chain.sendTransfer({ toAddress: SIM_ADDRESS, amount: order.payableAmount });
    first.chain.mine(5);

    // A brand-new process with only the database file and the same chain.
    const second = createHarness({ dbPath, maxBlocksPerPoll: 5, chain: first.chain, clock: first.clock });
    try {
      const results = await second.watcher.catchUp();
      expect(results.length).toBeGreaterThan(1); // needed several polls to catch up
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.at(-1)!.caughtUp).toBe(true);
      expect((await second.store.getOrder(order.id))!.status).toBe('confirmed');
    } finally {
      second.store.close(); // release the file before the temp folder is deleted
    }
  });

  it('keeps the cursor and records the error when the chain API fails', async () => {
    const h = harness();
    await h.watcher.pollOnce();
    const before = await h.store.getChainState('simulated');
    h.chain.getLatestBlockNumber = async () => {
      throw new Error('429 Too Many Requests');
    };
    const result = await h.watcher.pollOnce();
    expect(result.ok).toBe(false);
    const after = await h.store.getChainState('simulated');
    expect(after.cursorBlock).toBe(before.cursorBlock);
    expect(after.lastError).toContain('429');
  });
});

describe('order creation', () => {
  it('gives every open order on one address a different payable amount', async () => {
    const h = harness();
    const payables = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const order = await h.orders.createOrder({ amount: '10', network: 'simulated' });
      payables.add(formatAmount(order.payableAmount));
    }
    expect(payables.size).toBe(50);
  });

  it('spreads orders across the configured receiving addresses', async () => {
    const h = harness({ addresses: [SIM_ADDRESS, SIM_ADDRESS_2] });
    const a = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    const b = await h.orders.createOrder({ amount: '10', network: 'simulated' });
    expect(new Set([a.receivingAddress, b.receivingAddress]).size).toBe(2);
  });

  it('rejects invalid input', async () => {
    const h = harness();
    const bad = [
      { amount: '-5', network: 'simulated' },
      { amount: '10.123', network: 'simulated' }, // > 2 decimals
      { amount: '0.001', network: 'simulated' },
      { amount: '2000000', network: 'simulated' },
      { amount: '10', network: 'bitcoin' },
      { amount: '10', network: 'simulated', externalRef: "x'; DROP TABLE orders;--" },
      { amount: '10', network: 'simulated', payerTelegramChatId: 'abc' },
      { amount: '10', network: 'simulated', expiresInMinutes: 0 },
    ];
    for (const input of bad) {
      await expect(h.orders.createOrder(input)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    const h = harness();
    await h.orders.createOrder({ amount: '10', network: 'simulated' });
    expect(() => h.store.execRaw("UPDATE audit_log SET actor = 'attacker'")).toThrow(/append-only/);
    expect(() => h.store.execRaw('DELETE FROM audit_log')).toThrow(/append-only/);
  });
});

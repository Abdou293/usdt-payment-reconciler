// Creating orders: validate input, pick a receiving address, and assign a
// unique payable amount so the payment can be matched unambiguously.

import { randomUUID } from 'node:crypto';
import { formatAmount, parseAmount } from '../core/money.js';
import { pickUniquePayableAmount, type RandomIntFn } from '../core/uniqueAmount.js';
import type { Network, Order } from '../core/types.js';
import type { Store } from '../db/Store.js';
import type { Clock, ServiceConfig } from './config.js';

export interface CreateOrderInput {
  amount: string; //                  decimal string, e.g. "49.99"
  network: string;
  externalRef?: string | undefined; // merchant's own order number
  payerTelegramChatId?: string | undefined;
  expiresInMinutes?: number | undefined;
}

export class ValidationError extends Error {}

const MAX_ORDER_UNITS = parseAmount('1000000'); // 1,000,000 USDT safety cap
const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d{1,20}$/;

export class OrderService {
  constructor(
    private readonly store: Store,
    private readonly config: ServiceConfig,
    private readonly now: Clock = () => new Date(),
    private readonly random?: RandomIntFn,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const network = this.validateNetwork(input.network);
    const baseAmount = this.validateAmount(input.amount);
    const expiresInMinutes = input.expiresInMinutes ?? this.config.defaultExpiryMinutes;
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 1440) {
      throw new ValidationError('expiresInMinutes must be an integer between 1 and 1440');
    }
    if (input.externalRef !== undefined && !EXTERNAL_REF_PATTERN.test(input.externalRef)) {
      throw new ValidationError('externalRef must be 1-100 characters: letters, digits, . _ : -');
    }
    if (input.payerTelegramChatId !== undefined && !TELEGRAM_CHAT_ID_PATTERN.test(input.payerTelegramChatId)) {
      throw new ValidationError('payerTelegramChatId must be a numeric Telegram chat id');
    }

    return this.store.transaction(async () => {
      const now = this.now();
      const receivingAddress = await this.pickAddress(network);
      const reservedSince = new Date(now.getTime() - this.config.payment.lateReservationMinutes * 60_000);
      const candidates = await this.store.listMatchCandidates(network, 'USDT', receivingAddress, reservedSince);
      const reserved = new Set(candidates.map((o) => o.payableAmount));
      const payableAmount = pickUniquePayableAmount(baseAmount, reserved, this.random);

      const order: Order = {
        id: `ord_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        externalRef: input.externalRef ?? null,
        network,
        token: 'USDT',
        receivingAddress,
        baseAmount,
        payableAmount,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000),
        payerTelegramChatId: input.payerTelegramChatId ?? null,
        manuallyResolved: false,
      };
      await this.store.insertOrder(order);
      await this.store.addAudit({
        entityType: 'order',
        entityId: order.id,
        action: 'order_created',
        fromStatus: null,
        toStatus: 'pending',
        actor: 'system',
        details: {
          network,
          receivingAddress,
          baseAmount: formatAmount(baseAmount),
          payableAmount: formatAmount(payableAmount),
        },
        createdAt: now,
      });
      return order;
    });
  }

  private validateNetwork(value: string): Network {
    const network = value as Network;
    const settings = this.config.networks.get(network);
    if (!settings || settings.watchAddresses.length === 0) {
      throw new ValidationError(`Network "${value}" is not configured`);
    }
    return network;
  }

  private validateAmount(value: string): bigint {
    let units: bigint;
    try {
      units = parseAmount(String(value));
    } catch (error) {
      throw new ValidationError((error as Error).message);
    }
    if (units < parseAmount('0.01')) throw new ValidationError('Amount must be at least 0.01 USDT');
    if (units > MAX_ORDER_UNITS) throw new ValidationError('Amount exceeds the 1,000,000 USDT limit');
    // Keep the last 4 decimals free for the unique suffix.
    if (units % 10_000n !== 0n) throw new ValidationError('Amount may have at most 2 decimal places');
    return units;
  }

  /** Spread orders across addresses: choose the one with the fewest open orders. */
  private async pickAddress(network: Network): Promise<string> {
    const addresses = this.config.networks.get(network)!.watchAddresses;
    const load = await this.store.countOpenOrdersByAddress(network);
    let best = addresses[0]!;
    for (const address of addresses) {
      if ((load.get(address) ?? 0) < (load.get(best) ?? 0)) best = address;
    }
    return best;
  }
}

// Shared domain types.

export type Network = 'tron' | 'arbitrum' | 'bsc' | 'ethereum' | 'simulated';
export type Token = 'USDT';

/** Lifecycle of an ORDER (what the merchant is waiting to be paid). */
export const ORDER_STATUSES = [
  'pending', //       created, waiting for a payment
  'detected', //      matching transfer seen on-chain, 0 confirmations
  'confirming', //    transfer has some confirmations, fewer than required
  'confirmed', //     enough confirmations and amount within tolerance (final)
  'underpaid', //     confirmed but total paid is below tolerance (needs review)
  'overpaid', //      confirmed but total paid is above tolerance (needs review)
  'expired', //       no payment arrived before the expiry time
  'late_payment', //  a payment arrived after the expiry time (needs review)
  'cancelled', //     closed by an admin (e.g. refunded off-system), with a written reason
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Status of a single on-chain DEPOSIT (incoming transfer). */
export const PAYMENT_STATUSES = [
  'matched', //       linked to an order
  'unmatched', //     no order could be identified (needs review)
  'wrong_token', //   transfer of a token other than the configured USDT contract
  'orphaned', //      removed from the canonical chain by a reorganization
  'dismissed', //     reviewed by an admin and closed (e.g. refunded), with a written reason
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Order {
  id: string;
  externalRef: string | null;
  network: Network;
  token: Token;
  receivingAddress: string;
  baseAmount: bigint; //     what the merchant asked for
  payableAmount: bigint; //  base + unique suffix: what the payer must send exactly
  status: OrderStatus;
  createdAt: Date;
  expiresAt: Date;
  payerTelegramChatId: string | null;
  manuallyResolved: boolean;
}

export interface Payment {
  id: number;
  network: Network;
  txHash: string;
  logIndex: number;
  tokenContract: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  blockNumber: number;
  blockTimestamp: Date;
  status: PaymentStatus;
  orderId: string | null;
  note: string | null;
  firstSeenAt: Date;
}

/** A transfer as reported by a chain adapter (before it is stored). */
export interface TransferEvent {
  network: Network;
  txHash: string;
  logIndex: number;
  tokenContract: string;
  fromAddress: string;
  toAddress: string;
  /** Always in the internal 6-decimal unit (see toCanonicalUnits). */
  amount: bigint;
  blockNumber: number;
  blockTimestamp: Date;
  /** Set when the token has a different number of decimals (e.g. 18 on BSC). */
  raw?: { amount: string; decimals: number; dustIgnored: string };
}

export interface NetworkSettings {
  network: Network;
  usdtContract: string;
  requiredConfirmations: number;
}

export interface PaymentSettings {
  /** Amount below payable still accepted as paid (base units). */
  underpayToleranceUnits: bigint;
  /** Amount above payable still accepted as paid (base units). */
  overpayToleranceUnits: bigint;
  /** How long an order's unique amount stays reserved after expiry, to catch late payments. */
  lateReservationMinutes: number;
}

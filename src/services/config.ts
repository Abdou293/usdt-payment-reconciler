// Runtime configuration shared by services (built from .env in later phases).

import type { Network, NetworkSettings, PaymentSettings } from '../core/types.js';

export interface WatchedNetwork extends NetworkSettings {
  /** PUBLIC receiving addresses only. Never private keys. */
  watchAddresses: string[];
}

export interface ServiceConfig {
  networks: Map<Network, WatchedNetwork>;
  payment: PaymentSettings;
  defaultExpiryMinutes: number;
}

export type Clock = () => Date;

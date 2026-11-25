// Small typed client for the admin API. Cookies carry the session; the CSRF
// token (from /session or /login) is sent on every state-changing request.

export type OrderStatus =
  | 'pending' | 'detected' | 'confirming' | 'confirmed' | 'underpaid' | 'overpaid'
  | 'expired' | 'late_payment' | 'cancelled';

export const ORDER_STATUSES: OrderStatus[] = [
  'pending', 'detected', 'confirming', 'confirmed', 'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled',
];

export interface OrderDto {
  id: string;
  external_ref: string | null;
  network: string;
  token: string;
  receiving_address: string;
  base_amount: string;
  amount: string;
  paid_total?: string;
  status: OrderStatus;
  created_at: string;
  expires_at: string;
  manually_resolved: boolean;
  payer_telegram_linked: boolean;
  payer_link?: string | null;
}

export interface PaymentDto {
  id: number;
  network: string;
  tx_hash: string;
  log_index: number;
  explorer_url: string | null;
  token_contract: string;
  from_address: string;
  to_address: string;
  amount: string;
  block_number: number;
  block_time: string;
  status: 'matched' | 'unmatched' | 'wrong_token' | 'orphaned' | 'dismissed';
  order_id: string | null;
  note: string | null;
  first_seen_at: string;
}

export interface AuditDto {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  actor: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface SessionInfo {
  authenticated: boolean;
  username: string | null;
  csrf_token: string | null;
  mode: 'demo' | 'testnet' | 'mainnet';
  demo_credentials: { username: string; password: string } | null;
  password_reset_available: boolean;
  networks: Array<{ network: string; label: string }>;
}

export interface NetworkReport {
  network: string;
  ordersCreated: number;
  ordersByStatus: Partial<Record<OrderStatus, number>>;
  requestedTotal: string;
  confirmedReceivedTotal: string;
  depositsCount: number;
  depositsTotal: string;
  unmatchedCount: number;
  unmatchedTotal: string;
  wrongTokenCount: number;
  orphanedCount: number;
}

export interface ReportDto {
  period: 'day' | 'week';
  from: string;
  to: string;
  generatedAt: string;
  networks: NetworkReport[];
  exceptions: Array<{ kind: string; network: string; orderId: string | null; paymentId: number | null; detail: string }>;
}

export interface HealthDto {
  checked_at: string;
  watchers: Array<{
    network: string;
    label: string;
    required_confirmations: number;
    watch_addresses: string[];
    token_contract: string;
    cursor_block: number | null;
    latest_block: number | null;
    lag_blocks: number | null;
    last_poll_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    healthy: boolean;
  }>;
  deliveries: Record<string, number>;
  failed_deliveries: Array<{ id: number; channel: string; attempts: number; last_error: string | null; created_at: string }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null) => {
  csrfToken = token;
};

/** Called when the server says the session ended (401). */
let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && path !== '/login' && path !== '/password') onUnauthorized();
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  session: () => request<SessionInfo>('GET', '/session'),
  login: (username: string, password: string) => request<{ username: string; csrf_token: string }>('POST', '/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/password', { current_password: currentPassword, new_password: newPassword }),
  forgotPassword: (username: string) => request<{ ok: true; message: string }>('POST', '/password/forgot', { username }),
  resetPassword: (username: string, code: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/password/reset', { username, code, new_password: newPassword }),

  listOrders: (f: { status?: string; network?: string; q?: string; from?: string; to?: string; page?: number }) =>
    request<{ items: OrderDto[]; total: number; page: number; page_size: number }>('GET', `/orders${qs(f)}`),
  createOrder: (body: { amount: string; network: string; external_ref?: string; expires_in_minutes?: number }) =>
    request<OrderDto>('POST', '/orders', body),
  getOrder: (id: string) =>
    request<{ order: OrderDto; payments: PaymentDto[]; audit: AuditDto[]; payer_link: string | null }>('GET', `/orders/${encodeURIComponent(id)}`),
  acceptOrder: (id: string, reason: string) => request<{ ok: true }>('POST', `/orders/${encodeURIComponent(id)}/accept`, { reason }),
  cancelOrder: (id: string, reason: string) => request<{ ok: true }>('POST', `/orders/${encodeURIComponent(id)}/cancel`, { reason }),

  review: () => request<{ orders: OrderDto[]; payments: PaymentDto[] }>('GET', '/review'),
  assignPayment: (id: number, orderId: string, reason: string) => request<{ ok: true }>('POST', `/payments/${id}/assign`, { order_id: orderId, reason }),
  dismissPayment: (id: number, reason: string) => request<{ ok: true }>('POST', `/payments/${id}/dismiss`, { reason }),

  report: (period: 'day' | 'week', date: string) => request<ReportDto>('GET', `/reports/reconciliation${qs({ period, date })}`),
  health: () => request<HealthDto>('GET', '/health'),

  demoPay: (orderId: string, kind: 'exact' | 'under' | 'over' | 'base' | 'wrong_token') =>
    request<{ txHash: string }>('POST', '/demo/pay', { order_id: orderId, kind }),
  demoUnknownPayment: (amount: string) => request<{ txHash: string }>('POST', '/demo/unknown-payment', { amount }),
  demoMine: (blocks: number) => request<{ ok: true }>('POST', '/demo/mine', { blocks }),
  demoReorg: (depth: number) => request<{ ok: true }>('POST', '/demo/reorg', { depth }),
};

export const exportUrl = (kind: 'orders' | 'payments', from: string, to: string) =>
  `/admin/api/exports/${kind}.csv${qs({ from, to })}`;

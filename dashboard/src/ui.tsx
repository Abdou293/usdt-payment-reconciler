// Small shared UI pieces and formatters.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OrderStatus } from './api';

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  detected: 'Detected',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  underpaid: 'Underpaid',
  overpaid: 'Overpaid',
  expired: 'Expired',
  late_payment: 'Late payment',
  cancelled: 'Cancelled',
  matched: 'Matched',
  unmatched: 'Unmatched',
  wrong_token: 'Wrong token',
  orphaned: 'Orphaned (reorg)',
  dismissed: 'Dismissed',
};

const STATUS_TONE: Record<string, string> = {
  pending: 'neutral',
  detected: 'info',
  confirming: 'info',
  confirmed: 'good',
  matched: 'good',
  underpaid: 'warn',
  overpaid: 'warn',
  late_payment: 'warn',
  unmatched: 'warn',
  wrong_token: 'bad',
  orphaned: 'bad',
  expired: 'muted',
  cancelled: 'muted',
  dismissed: 'muted',
};

export function StatusBadge({ status }: { status: OrderStatus | string }) {
  return <span className={`badge badge-${STATUS_TONE[status] ?? 'neutral'}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** Amounts arrive as exact decimal strings; we only trim trailing zeros, never use floats. */
export const fmtAmount = (value: string | undefined) => {
  if (value === undefined) return '—';
  const [i, f = ''] = value.split('.');
  const frac = f.replace(/0+$/, '').padEnd(2, '0');
  return `${i}.${frac}`;
};

/** Human name of a network ("bsc" -> "BNB Smart Chain · BEP20 ..."), from the server's session info. */
export const networkLabel = (networks: ReadonlyArray<{ network: string; label: string }>, id: string) =>
  networks.find((n) => n.network === id)?.label ?? id;

export const shortHash = (h: string) => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);

export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const daysAgoUtc = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  return message ? <p className="error-note" role="alert">{message}</p> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Ask for a written reason before an admin action (kept in the audit log). */
export function ReasonAction({
  label,
  tone = 'primary',
  placeholder,
  onSubmit,
}: {
  label: string;
  tone?: 'primary' | 'danger' | 'secondary';
  placeholder: string;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return <button className={`btn btn-${tone}`} onClick={() => setOpen(true)}>{label}</button>;
  }
  return (
    <form
      className="reason-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit(reason);
          setOpen(false);
          setReason('');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} minLength={3} maxLength={500} required aria-label="Reason" />
      <button className={`btn btn-${tone}`} disabled={busy}>{busy ? 'Saving…' : label}</button>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      <ErrorNote message={error} />
    </form>
  );
}

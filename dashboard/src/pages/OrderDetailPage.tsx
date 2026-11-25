import { useEffect, useState } from 'react';
import { api, type PaymentDto, type SessionInfo } from '../api';
import { Card, Empty, ErrorNote, fmtAmount, fmtTime, ReasonAction, shortHash, STATUS_LABELS, StatusBadge, useAsync } from '../ui';

const REVIEW = ['underpaid', 'overpaid', 'late_payment'];
const CANCELLABLE = ['pending', 'underpaid', 'overpaid', 'late_payment'];
const OPEN = ['pending', 'detected', 'confirming'];

export function OrderDetailPage({ id, session }: { id: string; session: SessionInfo }) {
  const { data, error, reload } = useAsync(() => api.getOrder(id), [id]);
  const status = data?.order.status;

  // While a payment is in flight, refresh every few seconds.
  useEffect(() => {
    if (!status || !OPEN.includes(status)) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [status, reload]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { order, payments, audit, payer_link } = data;

  return (
    <>
      <header className="page-head">
        <a href="#/orders" className="back">← Orders</a>
        <h1>
          <span className="mono">{order.id}</span> <StatusBadge status={order.status} />
          {order.manually_resolved && <span className="tag">resolved manually</span>}
        </h1>
      </header>

      <div className="grid-2">
        <Card title="Payment request">
          <dl className="facts">
            <dt>Amount to pay</dt>
            <dd><strong className="mono big">{order.amount}</strong> {order.token}</dd>
            <dt>Base amount</dt>
            <dd className="mono">{fmtAmount(order.base_amount)} {order.token}</dd>
            <dt>Received</dt>
            <dd className="mono">{fmtAmount(order.paid_total)} {order.token}</dd>
            <dt>Network</dt>
            <dd>{order.network}</dd>
            <dt>Pay to (watch-only)</dt>
            <dd className="mono break">{order.receiving_address}</dd>
            <dt>Reference</dt>
            <dd>{order.external_ref ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{fmtTime(order.created_at)}</dd>
            <dt>Expires</dt>
            <dd>{fmtTime(order.expires_at)}</dd>
            <dt>Payer on Telegram</dt>
            <dd>
              {order.payer_telegram_linked ? 'Linked' : 'Not linked'}
              {payer_link && <> · <a href={payer_link} target="_blank" rel="noreferrer noopener">payer link</a></>}
            </dd>
          </dl>
          <div className="actions">
            {REVIEW.includes(order.status) && (
              <ReasonAction
                label="Accept as paid"
                placeholder="Why is this acceptable? (kept in the audit log)"
                onSubmit={async (reason) => {
                  await api.acceptOrder(order.id, reason);
                  await reload();
                }}
              />
            )}
            {CANCELLABLE.includes(order.status) && (
              <ReasonAction
                label="Cancel order"
                tone="danger"
                placeholder="Reason for cancelling"
                onSubmit={async (reason) => {
                  await api.cancelOrder(order.id, reason);
                  await reload();
                }}
              />
            )}
          </div>
        </Card>

        {session.mode === 'demo' && <DemoPanel orderId={order.id} canPay={!['confirmed', 'cancelled'].includes(order.status)} onDone={reload} />}
      </div>

      <Card title="On-chain payments">
        {payments.length === 0 ? <Empty>No transfer seen yet for this order.</Empty> : <PaymentsTable payments={payments} />}
      </Card>

      <Card title="Audit trail">
        {audit.length === 0 ? (
          <Empty>No entries.</Empty>
        ) : (
          <ol className="timeline">
            {audit.map((a) => (
              <li key={`${a.entity_type}-${a.id}`}>
                <time>{fmtTime(a.created_at)}</time>
                <div>
                  <strong>{a.action.replaceAll('_', ' ')}</strong>
                  {a.from_status && a.to_status && (
                    <span className="muted"> {STATUS_LABELS[a.from_status] ?? a.from_status} → {STATUS_LABELS[a.to_status] ?? a.to_status}</span>
                  )}
                  <span className="muted"> · {a.actor}</span>
                  {a.details && <p className="details">{formatDetails(a.details)}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}

/** Audit details are a small JSON object; show them as "key: value" text (React escapes it). */
function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

export function PaymentsTable({ payments, extra }: { payments: PaymentDto[]; extra?: (p: PaymentDto) => React.ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Block time</th>
            <th>Transaction</th>
            <th>From</th>
            <th className="num">Amount</th>
            <th>Block</th>
            <th>Status</th>
            {extra && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td>{fmtTime(p.block_time)}</td>
              <td className="mono">
                {p.explorer_url && p.explorer_url.startsWith('https://') ? (
                  <a href={p.explorer_url} target="_blank" rel="noreferrer noopener">{shortHash(p.tx_hash)}</a>
                ) : (
                  <span title={p.tx_hash}>{shortHash(p.tx_hash)}</span>
                )}
                <small className="muted"> #{p.log_index}</small>
              </td>
              <td className="mono">{shortHash(p.from_address)}</td>
              <td className="num mono">{fmtAmount(p.amount)}</td>
              <td className="mono">{p.block_number}</td>
              <td>
                <StatusBadge status={p.status} />
                {p.note && <small className="muted block">{p.note}</small>}
              </td>
              {extra && <td>{extra(p)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DemoPanel({ orderId, canPay, onDone }: { orderId: string; canPay: boolean; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMessage(label);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Simulator (demo only)">
      <p className="hint">Act as the payer and the blockchain. Payments need 3 confirmations; one block is also mined every 10 seconds.</p>
      <div className="button-grid">
        <button className="btn btn-secondary" disabled={!canPay || busy} onClick={() => run('Sent the exact amount', () => api.demoPay(orderId, 'exact'))}>Pay exact amount</button>
        <button className="btn btn-secondary" disabled={!canPay || busy} onClick={() => run('Sent 1 USDT too little', () => api.demoPay(orderId, 'under'))}>Underpay by 1</button>
        <button className="btn btn-secondary" disabled={!canPay || busy} onClick={() => run('Sent 2.50 USDT too much', () => api.demoPay(orderId, 'over'))}>Overpay by 2.50</button>
        <button className="btn btn-secondary" disabled={!canPay || busy} onClick={() => run('Sent the base amount (forgot the unique digits)', () => api.demoPay(orderId, 'base'))}>Pay base amount</button>
        <button className="btn btn-secondary" disabled={!canPay || busy} onClick={() => run('Sent a different token (not USDT)', () => api.demoPay(orderId, 'wrong_token'))}>Send wrong token</button>
      </div>
      <div className="button-grid">
        <button className="btn btn-ghost" disabled={busy} onClick={() => run('Mined 1 block', () => api.demoMine(1))}>Mine 1 block</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => run('Mined 3 blocks', () => api.demoMine(3))}>Mine 3 blocks</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => run('Reorg: the last block was replaced', () => api.demoReorg(1))}>Simulate reorg (1 block)</button>
      </div>
      {message && !error && <p className="ok-note">{message}.</p>}
      <ErrorNote message={error} />
    </Card>
  );
}

import { useState } from 'react';
import { api, type PaymentDto } from '../api';
import { Card, Empty, ErrorNote, fmtAmount, fmtTime, ReasonAction, StatusBadge, useAsync } from '../ui';
import { PaymentsTable } from './OrderDetailPage';

export function ReviewPage() {
  const { data, error, reload } = useAsync(() => api.review(), []);

  return (
    <>
      <header className="page-head">
        <h1>Review queue</h1>
        <p className="muted">Payments the system will not decide alone. Every decision needs a reason and is written to the audit log.</p>
      </header>
      <ErrorNote message={error} />

      <Card title={`Orders needing a decision${data ? ` (${data.orders.length})` : ''}`} actions={<button className="btn btn-ghost" onClick={() => void reload()}>Refresh</button>}>
        {data && data.orders.length === 0 && <Empty>Nothing to review. 🎉</Empty>}
        {data && data.orders.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Order</th>
                  <th className="num">Requested</th>
                  <th className="num">Received</th>
                  <th>Status</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{fmtTime(o.created_at)}</td>
                    <td>
                      <a href={`#/orders/${o.id}`} className="mono">{o.id}</a>
                      {o.external_ref && <small className="muted block">{o.external_ref}</small>}
                    </td>
                    <td className="num mono">{o.amount}</td>
                    <td className="num mono">{fmtAmount(o.paid_total)}</td>
                    <td><StatusBadge status={o.status} /></td>
                    <td className="actions">
                      <ReasonAction label="Accept" placeholder="Reason" onSubmit={async (r) => { await api.acceptOrder(o.id, r); await reload(); }} />
                      <ReasonAction label="Cancel" tone="danger" placeholder="Reason" onSubmit={async (r) => { await api.cancelOrder(o.id, r); await reload(); }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Unmatched and wrong-token transfers${data ? ` (${data.payments.length})` : ''}`}>
        {data && data.payments.length === 0 && <Empty>No unexplained transfers.</Empty>}
        {data && data.payments.length > 0 && (
          <PaymentsTable payments={data.payments} extra={(p) => <PaymentActions payment={p} onDone={reload} />} />
        )}
      </Card>
    </>
  );
}

function PaymentActions({ payment, onDone }: { payment: PaymentDto; onDone: () => Promise<void> }) {
  const [orderId, setOrderId] = useState('');
  return (
    <div className="actions stack">
      {payment.status === 'unmatched' && (
        <div className="assign">
          <input value={orderId} onChange={(e) => setOrderId(e.target.value.trim())} placeholder="ord_… to assign to" aria-label="Order id" />
          <ReasonAction
            label="Assign"
            placeholder="Why does this payment belong to that order?"
            onSubmit={async (r) => {
              await api.assignPayment(payment.id, orderId, r);
              await onDone();
            }}
          />
        </div>
      )}
      <ReasonAction label="Dismiss" tone="secondary" placeholder="Reason (e.g. refunded, own test transfer)" onSubmit={async (r) => { await api.dismissPayment(payment.id, r); await onDone(); }} />
    </div>
  );
}

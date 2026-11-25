import { useState } from 'react';
import { api, ORDER_STATUSES, type SessionInfo } from '../api';
import { Card, Empty, ErrorNote, fmtAmount, fmtTime, STATUS_LABELS, StatusBadge, useAsync } from '../ui';

const PAGE_SIZE = 25;

export function OrdersPage({ session }: { session: SessionInfo }) {
  const [filters, setFilters] = useState({ status: '', network: '', q: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(() => api.listOrders({ ...applied, page }), [applied, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <header className="page-head">
        <h1>Orders</h1>
        <p className="muted">Every payment request, its exact payable amount and its on-chain status.</p>
      </header>

      <CreateOrder session={session} onCreated={(id) => (window.location.hash = `#/orders/${id}`)} />

      <Card
        title={data ? `${data.total} order${data.total === 1 ? '' : 's'}` : 'Orders'}
        actions={<button className="btn btn-ghost" onClick={() => void reload()}>Refresh</button>}
      >
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied(filters);
          }}
        >
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Status">
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <select value={filters.network} onChange={(e) => setFilters({ ...filters, network: e.target.value })} aria-label="Network">
            <option value="">All networks</option>
            {session.networks.map((n) => <option key={n.network} value={n.network}>{n.label}</option>)}
          </select>
          <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Order id or reference" aria-label="Search" />
          <label className="inline">From <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
          <label className="inline">To <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
          <button className="btn btn-secondary">Apply</button>
        </form>
        <ErrorNote message={error} />
        {data && data.items.length === 0 && <Empty>No orders match these filters.</Empty>}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Order</th>
                  <th>Reference</th>
                  <th>Network</th>
                  <th className="num">Amount (USDT)</th>
                  <th className="num">Paid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => (window.location.hash = `#/orders/${o.id}`)}>
                    <td>{fmtTime(o.created_at)}</td>
                    <td><a href={`#/orders/${o.id}`} className="mono">{o.id}</a></td>
                    <td>{o.external_ref ?? <span className="muted">—</span>}</td>
                    <td>{o.network}</td>
                    <td className="num mono">{o.amount}</td>
                    <td className="num mono">{fmtAmount(o.paid_total)}</td>
                    <td><StatusBadge status={o.status} />{o.manually_resolved && <span className="tag">manual</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <button className="btn btn-ghost" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>← Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button className="btn btn-ghost" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      </Card>
    </>
  );
}

function CreateOrder({ session, onCreated }: { session: SessionInfo; onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ amount: '', network: session.networks[0]?.network ?? '', external_ref: '', expires: '30' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setOpen(true)}>+ New payment request</button>
      </div>
    );
  }
  return (
    <Card title="New payment request">
      <form
        className="grid-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const order = await api.createOrder({
              amount: form.amount.trim(),
              network: form.network,
              external_ref: form.external_ref.trim() || undefined,
              expires_in_minutes: Number(form.expires),
            });
            onCreated(order.id);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Amount (USDT)
          <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="49.99" inputMode="decimal" pattern="\d{1,9}(\.\d{1,2})?" required />
        </label>
        <label>
          Network
          <select value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })}>
            {session.networks.map((n) => <option key={n.network} value={n.network}>{n.label}</option>)}
          </select>
        </label>
        <label>
          Your reference (optional)
          <input value={form.external_ref} onChange={(e) => setForm({ ...form, external_ref: e.target.value })} placeholder="INV-1042" maxLength={100} />
        </label>
        <label>
          Expires in (minutes)
          <input type="number" min={1} max={1440} value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        </div>
        <ErrorNote message={error} />
        <p className="hint">The payer is asked for a unique amount (a few extra micro-units) so each payment matches exactly one order.</p>
      </form>
    </Card>
  );
}

import { useState } from 'react';
import { api, exportUrl, type OrderStatus } from '../api';
import { Card, daysAgoUtc, Empty, ErrorNote, fmtAmount, fmtTime, STATUS_LABELS, todayUtc, useAsync } from '../ui';

export function ReportsPage() {
  const [period, setPeriod] = useState<'day' | 'week'>('week');
  const [date, setDate] = useState(todayUtc());
  const { data, error, loading } = useAsync(() => api.report(period, date), [period, date]);
  const [from, setFrom] = useState(daysAgoUtc(6));
  const [to, setTo] = useState(todayUtc());

  return (
    <>
      <header className="page-head">
        <h1>Reconciliation</h1>
        <p className="muted">What was requested versus what actually arrived on-chain, per network (UTC).</p>
      </header>

      <Card
        title="Report"
        actions={
          <div className="filters compact">
            <select value={period} onChange={(e) => setPeriod(e.target.value as 'day' | 'week')} aria-label="Period">
              <option value="day">Daily</option>
              <option value="week">Weekly (7 days)</option>
            </select>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value || todayUtc())} aria-label="Ending on" />
          </div>
        }
      >
        <ErrorNote message={error} />
        {loading && !data && <p className="muted">Loading…</p>}
        {data && (
          <>
            <p className="muted">{fmtTime(data.from)} → {fmtTime(data.to)}</p>
            {data.networks.length === 0 && <Empty>No activity in this period.</Empty>}
            {data.networks.map((n) => (
              <div key={n.network} className="report-network">
                <h3>{n.network}</h3>
                <div className="stats">
                  <Stat label="Requested" value={fmtAmount(n.requestedTotal)} hint={`${n.ordersCreated} orders created`} />
                  <Stat label="Received for confirmed orders" value={fmtAmount(n.confirmedReceivedTotal)} hint={`${n.ordersByStatus.confirmed ?? 0} confirmed`} />
                  <Stat label="All USDT deposits seen" value={fmtAmount(n.depositsTotal)} hint={`${n.depositsCount} transfers`} />
                  <Stat label="Unmatched" value={fmtAmount(n.unmatchedTotal)} hint={`${n.unmatchedCount} transfers`} tone={n.unmatchedCount ? 'warn' : undefined} />
                </div>
                <div className="status-row">
                  {Object.entries(n.ordersByStatus).map(([s, c]) => (
                    <span key={s} className="chip">{STATUS_LABELS[s as OrderStatus] ?? s}: <strong>{c}</strong></span>
                  ))}
                  {n.wrongTokenCount > 0 && <span className="chip">Wrong token: <strong>{n.wrongTokenCount}</strong></span>}
                  {n.orphanedCount > 0 && <span className="chip">Orphaned by reorg: <strong>{n.orphanedCount}</strong></span>}
                </div>
              </div>
            ))}

            <h3>Exceptions ({data.exceptions.length})</h3>
            {data.exceptions.length === 0 ? (
              <Empty>No exceptions. Everything requested was paid exactly.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Kind</th><th>Network</th><th>Reference</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {data.exceptions.map((e, i) => (
                      <tr key={i}>
                        <td>{e.kind.replaceAll('_', ' ')}</td>
                        <td>{e.network}</td>
                        <td>{e.orderId ? <a href={`#/orders/${e.orderId}`} className="mono">{e.orderId}</a> : <span className="mono">payment #{e.paymentId}</span>}</td>
                        <td className="mono small">{e.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="CSV export">
        <div className="filters">
          <label className="inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <a className="btn btn-secondary" href={exportUrl('orders', from, to)} download>Download orders.csv</a>
          <a className="btn btn-secondary" href={exportUrl('payments', from, to)} download>Download payments.csv</a>
        </div>
        <p className="hint">Amounts are exact decimal strings. Cells that could run as spreadsheet formulas are neutralised.</p>
      </Card>
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'warn' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value mono">{value} <small>USDT</small></span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}
